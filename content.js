/**
 * Content bridge for Omitone.
 * Injects the bundled page runtime and proxies extension APIs into page context.
 */
(function () {
  'use strict';

  const AUTO_START_ATTR = 'data-xxt-auto-start';
  const PAGE_SCRIPT_ID = 'xxt-page-script';
  const STATUS_PANEL_ID = 'omitone-status-panel-host';

  if (window.top !== window) {
    console.log('%c[Omitone] skip nested frame bridge', 'color:#999');
    return;
  }

  // Host text and captcha-looking DOM are not authority. The worker checks the current tab URL
  // and the explicitly granted, expiring captcha session on every privileged entry point.
  const POLICY = (typeof self !== 'undefined' && self.OmitonePolicy) || null;
  let pageScope = 'none';
  let scopeUrl = '';
  let scopeExpiresAt = 0;
  let requestFingerprints = new WeakMap();

  function scopeIsCurrent(required) {
    return !!POLICY && scopeUrl === location.href &&
      (!scopeExpiresAt || Date.now() < scopeExpiresAt) &&
      (required ? pageScope === required : pageScope !== 'none');
  }

  async function refreshPageScope() {
    const url = location.href;
    const response = await sendRuntimeMessageWithTimeout({ type: 'get_page_scope' }, 5000, 'scope check timeout');
    if (location.href !== url) return 'none';
    const scope = response && response.success ? response.scope : 'none';
    pageScope = POLICY && ((scope === 'study' && POLICY.isChaoxingUrl(url)) ||
      (scope === 'captcha' && !POLICY.isChaoxingUrl(url))) ? scope : 'none';
    scopeUrl = url;
    scopeExpiresAt = Number(response && response.expiresAt) || 0;
    return scopeIsCurrent() ? pageScope : 'none';
  }

  // ⚠️ 有界重试，别只问一次。
  // 为什么必须有（2026-11-11 真页面实测）：学习通切章节走的是 `pushState`（同一个 JS 上下文，
  // 不换文档），那一刻 SW 侧 `tabs.onUpdated` 会把标签页纪元跳一格（`revokeTab`），
  // 正好落进 `pageScope()` 那次异步 `chrome.tabs.get` 的窗口里 → 回 `'none'`。
  // 旧代码问一次拿到 'none' 就放弃，于是**整页与扩展永久失联**：
  // `_xxtApp` 还在每秒 tick，桥却全部 `scope_denied`，日志一条不进，
  // 用户看到的只有一句话 ——「卡住了 / 又不答题了」，而唯一的解法是手动 F5。
  // 按 0/500/1500/3500ms 问四次；问不到才认输。
  async function refreshPageScopeWithRetry() {
    const waits = [0, 500, 1500, 3500];
    const askedUrl = location.href;
    for (let i = 0; i < waits.length; i++) {
      if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
      // 期间又换页了：这一轮作废，交给新网址自己的那次调用
      if (location.href !== askedUrl) return 'none';
      const scope = await refreshPageScope();
      if (scope !== 'none') return scope;
      // 非学习通网址（也没拿到验证码授权）的 'none' 是**确定答案**，不是竞态，不用重问
      if (!(POLICY && POLICY.isChaoxingUrl(location.href))) return 'none';
    }
    return 'none';
  }

  function publicConfig(config) {
    const scope = scopeIsCurrent() ? pageScope : 'none';
    return POLICY ? { ...POLICY.publicConfig(config, scope), pageScope: scope } : {};
  }

  let configs = {
    playbackRate: 1.0,
    muted: false,
    autoNext: true,
    enableQuiz: true,
    randomAnswer: false,
    // 乱选交卷前留给用户检查的秒数（真源在 src/page/00-shell-constants.js；
    // 配置没加载完时 content 侧靠它兜底，别让它读成 undefined）。
    randomAnswerReviewSec: 30,
    enableMedia: true,
    enablePPT: true,
    enableHyperlink: true,
    restudy: false,
    providerPreset: 'deepseek',
    apiType: 'openai',
    apiUrl: 'https://api.deepseek.com',
    apiKey: '',
    apiConnectionFailed: false,
    model: 'deepseek-flash',
    systemPrompt: '',
    // 思考强度：'off'（默认）/ 'low' / 'high'。详见 libs/thinking.js。
    // 必须在这里也放一份：content.js 在配置还没加载完时靠它兜底，
    // 缺了会读成 undefined（`tools/check.js` 的「读了就必须有自己的默认值」守卫会报错）。
    thinkingLevel: 'off',
    // 慢机自适应开关：auto / on / off。content 侧用它放宽注入探针与字形表加载的超时，
    // page 侧还会结合实测帧率再算一次系数（见 00-shell-constants.js 的 perfFactor）。
    // 必须在这里放一份：配置未加载完时靠它兜底，check 的「读了就要有默认值」守卫会核对。
    slowMachineMode: 'auto',
    retryInterval: 2000,
    maxRetries: 10,
    videoCheckInterval: 1500,
    guardNoProgressMs: 6000,
    // 单个任务点连续几次"派发了但没完成"就放弃（24 小时内不再尝试）。
    // 用于对付老师设成防拖拽/不可翻页、或本身不计分的任务点。
    taskGiveUpAttempts: 4,
    guardResumeCooldownMs: 2500,
    guardMaxResumeWindow: 15000,
    guardMaxResumes: 5
  };

  const CONFIG_DEFAULTS = { ...configs };
  // content 侧拿不到 page 的 rAF 测速结果，用逻辑核心数做即时判据（不需要等采样完成）。
  // 只在「慢机」时放宽注入探针与字形表加载的超时，避免轻薄本上误报「运行脚本未响应」。
  function contentSlowFactor() {
    const mode = String((configs && configs.slowMachineMode) || 'auto');
    if (mode === 'off') return 1;
    if (mode === 'on') return 2;
    try {
      const cores = Number(navigator.hardwareConcurrency || 0);
      if (cores > 0 && cores <= 2) return 2;
      if (cores > 0 && cores <= 4) return 1.5;
      // 轻薄本常见「8 核但单核很弱」：核心数看不出慢，再按内存兜一层。
      const mem = Number(navigator.deviceMemory || 0);
      if (mem > 0 && mem <= 4) return 1.5;
    } catch (eCores) {}
    return 1;
  }
  function contentScaledMs(base) {
    return Math.round(Number(base || 0) * contentSlowFactor());
  }
  let decryptTablePromise = null;
  let decryptTableRetryAt = 0;
  let decryptTableFailures = 0;
  const DECRYPT_FETCH_TIMEOUT_MS = 10000;
  const decryptMapCache = new Map();
  const MAX_DECRYPT_FONTS = 16;
  // 字形未命中日志的节流戳：表过期时 .font-cxsecret 类名不会被移除、扫描会反复进入
  // 未命中分支，没有节流会把日志缓冲刷满（本仓库对重复 warn 的一贯处理）
  let lastFontMissLogAt = 0;
  let decryptSweepTimer = null;
  // 「有界防抖」（2026-11-10 批次 5）。原来只有 300ms 的**尾部**防抖：每次 DOM 变动都
  // clearTimeout 重新计时。而 page.js 自己就在不停地写 DOM（填答、审计、状态标记），
  // OCS 循环每秒一轮 —— 变动间隔只要长期小于 300ms，扫描就**永远排不到**。
  // 表现正是用户报的「连解码都没有」，而且因为三条静默分支都够不着（根本没跑），
  // 解密层一条日志都不出 —— 黑盒。现在：最长等 2 秒必跑一次，两次扫描至少隔 400ms。
  const DECRYPT_SWEEP_DEBOUNCE_MS = 300;
  const DECRYPT_SWEEP_MAX_WAIT_MS = 2000;
  const DECRYPT_SWEEP_MIN_GAP_MS = 400;
  let decryptSweepPendingSince = 0;
  let decryptSweepLastAt = 0;
  let decryptSweepRunning = false;
  // 每份文档的解密结论写在它的 documentElement 上，page.js 的「等解密」闸门与排查日志读它。
  // ⚠️ 结论必须可见：否则「解不出来」和「根本没去解」在日志里长得一模一样。
  const FONT_STATE_ATTR = 'data-om-font-state';
  const FONT_SWEEP_ATTR = 'data-om-font-sweep';
  const fontVerdictLog = new WeakMap();
  const observedDocs = new WeakSet();
  let statusPanel = null;
  let statusPanelActive = false;
  let statusLastSignature = '';
  let pageRuntimeActivityAt = 0;
  // 本次注入的「出发时刻」。判"运行脚本有没有响应"要用它，不能用"最近几秒有没有日志"——
  // 空闲时 ocs 循环 60 秒才写一条（实测 11:58:41 刚写过日志，11:58:47 就报未响应）。
  let pageRuntimeArmedAt = 0;
  let pageInjectSeq = 0;
  // 「前缀缓存全未命中」的日志节流。命中恒为 0 是**已知常态**（见 libs/prompt.js
  // 的 v3.1 实测记录：64 token 阈值不可信，公共前缀落不了盘）—— 每请求一条 warn
  // 会把 200 条环形缓冲冲掉十几条、盖住真错误。5 分钟最多一条，并报被压掉的条数。
  let prefixMissLogAt = 0;
  let prefixMissSuppressed = 0;
  let runtimeLogWarningAt = 0;

  function appendRuntimeLog(level, message, meta) {
    // 本地权限过期时**学习通页面**的日志照样发出去 —— 真正的裁决在 SW（`runtimeLogs.authorize`
    // 每次都重新核对标签页网址），本地这道闸只是省一次 IPC，可它顺带把唯一的自证据
    // （`content bridge ready` 那条 build 标记）也一起咽了：桥失联的时候，
    // 排查的人看到的正是「一条日志都没有」，而这条本该是最先看见的。
    // 非学习通网址（靠验证码临时授权）仍走原路，别把那张墙的日志放宽。
    if (!scopeIsCurrent() && !(POLICY && POLICY.isChaoxingUrl(location.href))) return;
    const item = {
      time: Date.now(),
      level: level || 'info',
      message: String(message || '').slice(0, 2000),
      meta: meta || null
    };
    // 不等待日志完成，不阻塞学习；Worker 负责跨标签页串行写入及权限核验。
    sendRuntimeMessageWithTimeout({ type: 'runtime_log_append', payload: item }, 20000, 'log request timeout')
      .then((result) => {
        if (result && result.success) return;
        if (Date.now() - runtimeLogWarningAt > 30000) {
          runtimeLogWarningAt = Date.now();
          console.warn('[Omitone] runtime log unavailable; study continues');
        }
      }).catch(() => {});
  }

  function sendRuntimeMessageWithTimeout(message, timeoutMs, timeoutError) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, error: timeoutError || '请求超时' });
      }, timeoutMs || 60000);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ success: false, error: lastError.message || String(lastError) });
            return;
          }
          resolve(response || { success: false, error: '后台无响应' });
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: error && error.message ? error.message : String(error) });
      }
    });
  }

  // API 地址构造与密钥清洗的唯一真源是 libs/api-url.js（manifest 里排在 content.js 之前注入）。
  // 这几段原先在 content.js 与 popup/popup.js 里各写了一份，并且已经分叉 ——
  // 只有 popup 那份会剥掉用户粘贴时带上的引号，于是"弹窗测试通过、页面回答题失败"
  // 这类诡异现象就有了土壤。这里只做转发，调用点保持不变。
  const API_URL = (typeof self !== 'undefined' && self.OmitoneApiUrl) || null;

  // 字形哈希表的编解码唯一真源是 libs/font-table.js（同样排在 content.js 之前注入）
  const FONT_TABLE = (typeof self !== 'undefined' && self.OmitoneFontTable) || null;

  function normalizeApiKey(apiKey) {
    return API_URL.normalizeApiKey(apiKey);
  }

  function buildOpenAICompatibleUrl(apiUrl) {
    return API_URL.buildOpenAICompatibleUrl(apiUrl);
  }

  function buildClaudeApiUrl(apiUrl) {
    return API_URL.buildClaudeApiUrl(apiUrl);
  }

  function buildGeminiApiUrl(apiUrl, model, apiKey) {
    return API_URL.buildGeminiApiUrl(apiUrl, model, apiKey);
  }

  // 提示词唯一真源在 libs/prompt.js（manifest 里排在 content.js 之前注入）。
  // 两个文件来自同一次扩展加载，不会出现版本错配；若真缺失说明扩展资源损坏，
  // 此时宁可明确报错，也不要用一份悄悄分叉的兜底提示词继续答题。
  const PROMPT = (typeof self !== 'undefined' && self.OmitonePrompt) || null;

  // 思考参数的唯一真源是 libs/thinking.js（同样排在 content.js 之前注入）。
  // 原先这里写死成"只对 DeepSeek 加 thinking:{type:disabled}"，改为按渠道白名单：
  // 不认识的渠道在"关闭"档一个参数都不发 —— 与升级前的行为完全一致，
  // 所以不会把任何现有用户搞成 400。详见那个文件顶部的说明。
  const THINKING = (typeof self !== 'undefined' && self.OmitoneThinking) || null;
  const API_ERROR = (typeof self !== 'undefined' && self.OmitoneApiError) || null;
  const STUDY_STATS = (typeof self !== 'undefined' && self.OmitoneStudyStats) || null;

  /**
   * 扩展自带资源缺失时的统一报错。
   *
   * 这些模块（libs/prompt.js、libs/api-url.js）由 manifest 在 content.js 之前注入，
   * 正常情况下不可能缺。但真缺的时候，若不做检查，症状是
   * `Cannot read properties of null (reading 'buildOpenAICompatibleUrl')`
   * —— 完全看不出是"扩展没重新加载"，排查成本极高。
   * 统一返回一句可操作的提示，比抛原生 TypeError 有用得多。
   */
  function missingModuleError() {
    if (!API_URL) return 'api-url module missing (libs/api-url.js) — 请在 edge://extensions 重新加载扩展';
    if (!PROMPT) return 'prompt module missing (libs/prompt.js) — 请在 edge://extensions 重新加载扩展';
    if (!THINKING) return 'thinking module missing (libs/thinking.js) — 请在 edge://extensions 重新加载扩展';
    return '';
  }

  /**
   * 这次请求该带哪些思考参数（按渠道白名单，见 libs/thinking.js）。
   *
   * 返回一个**可安全合并进请求体**的对象：认不出的渠道返回空对象 ——
   * 每个厂商对未知参数的反应不一样，有的忽略、有的直接 400，
   * 所以"不发"永远是安全默认。
   */
  function buildThinkingParams(config) {
    if (!THINKING) return {};
    try {
      return THINKING.buildThinkingParams(config).params || {};
    } catch (e) {
      return {};
    }
  }

  function buildSystemPrompt(config) {
    return PROMPT.buildSystemPrompt(config);
  }

  /**
   * 按题型把答案规整成 page.js 能匹配的形态。
   *
   * 位置式输出（`["A",["A","C"],true,…]`）虽然短，但模型偶尔会：
   *   - 把单选答成单元素数组 `["A"]`
   *   - 把判断答成中文 "正确" / "错误"，或 "T"/"√"
   * 这两种形态原样交给 page.js，`_matchOptionItem` 匹配不上，
   * 结果是**这题静默不填** → 表单不满 → 永不提交，且要等下一轮 tick 才重试。
   * 在这里顺手规整，能把"静默不填"变回"正常作答"，代价几乎为零。
   *
   * 只做无歧义的转换：数组→首个非空元素仅用于单选/判断（多选必须保留整个数组）。
   */
  function coerceAnswerForType(answer, type) {
    if (!type) return answer;

    if ((type === 'single' || type === 'judge') && Array.isArray(answer)) {
      var first = answer.filter(function (item) {
        return item !== null && item !== undefined && String(item).trim() !== '';
      })[0];
      // 全部元素都为空时原样返回，交给下游按空答案丢弃
      return first === undefined ? answer : first;
    }

    if (type === 'judge' && typeof answer === 'string') {
      var text = answer.trim();
      if (/^(正确|对|是|√|true|t|yes|y)$/i.test(text)) return true;
      if (/^(错误|错|否|×|x|false|f|no|n)$/i.test(text)) return false;
    }

    return answer;
  }

  /**
   * 这个 finish reason 是不是「输出被 max_tokens 截断」。
   *
   * 三个渠道字段名与取值都不一样，必须都认：
   *   OpenAI 兼容：`choices[0].finish_reason === 'length'`
   *   Claude：      `stop_reason === 'max_tokens'`
   *   Gemini：      `candidates[0].finishReason === 'MAX_TOKENS'`
   * 少认一家，那家就会退回"普通解析失败"那条路 —— 也就是**拿同一批题重问两次、
   * 再补问两次**，一轮六次顶满输出上限（实测现场就是这么烧的）。
   */
  function isTruncatedFinishReason(reason) {
    const value = String(reason || '').trim().toLowerCase().replace(/[\s_-]/g, '');
    return value === 'length' || value === 'maxtokens';
  }

  /**
   * 按分隔符切分后逐个 JSON.parse —— **只在段数恰好等于题数时才返回结果**。
   *
   * ⚠️ 那条"严格等长"是必须的：段数对不上时按段对齐会**错位答错题**，
   * 比"这几题没答上"严重得多（本项目对"拿不准"的一贯取舍）。
   * 尤其 `|||` 是**填空题自带的多空分隔符**：一段答案里出现它就会多切出一段，
   * 于是段数 ≠ 题数 → 这里直接返回 null，退回"判失败"，不会错位。
   */
  function parseSeparatedAnswers(cleaned, separator, expectedCount) {
    if (!Number.isFinite(expectedCount) || expectedCount <= 0) return null;
    if (!separator || cleaned.indexOf(separator) === -1) return null;
    const parts = cleaned.split(separator)
      .map(function (part) { return part.trim(); })
      .filter(function (part) { return part !== ''; });
    if (parts.length !== expectedCount) return null;
    const parsed = [];
    for (let i = 0; i < parts.length; i++) {
      try {
        parsed.push(JSON.parse(parts[i]));
      } catch (e) {
        return null;
      }
    }
    return parsed.length === expectedCount ? parsed : null;
  }

  /**
   * 把**被压平**的位置式数组贪心重新分段回"每题一项"。
   *
   * 现场证据（2026-10-10，用户那份 25 题的卷子）：模型答多选时会**把选项字母摊平**，
   * 5 道题（3 多选 + 2 填空）回成 **13 项**：
   *   `["A","B","C","D","A","B","C","D","A","B","C","人工智能通识","人工智能"]`
   * —— 4+4+3（三道多选的字母） + 1+1（两道填空），**答案其实全在**，
   * 只是长度对不上；而"长度对不上"会连锁触发丢弃 → 补问 → 又摊平 → 每轮空转。
   *
   * 分段依据（都来自真实 DOM，不猜）：
   *   - 每个条目的题型已知（`entry.type`）与选项数已知（`entry.question.options.length`）
   *   - 字母项只可能属于选择题；非字母项（填空文本）只可能是非选择题
   *   - 多选至少 2 项（本仓库既有规则），且不得超过该题的选项数
   *   - 给后面的题各留 ≥1 项
   *
   * @returns {Array|null} 分好段的数组（长度 === entries.length）；分不出来返回 null
   */
  function resegmentFlatAnswers(entries, data) {
    if (!Array.isArray(entries) || !Array.isArray(data)) return null;
    if (data.length <= entries.length) return null;
    const out = [];
    let cursor = 0;
    for (let k = 0; k < entries.length; k++) {
      const entry = entries[k];
      const remainingEntries = entries.length - 1 - k;
      const maxTake = data.length - cursor - remainingEntries; // 给后面的题各留 1 项
      if (maxTake < 1) return null;
      const type = String((entry && entry.type) || '');
      if (type === 'multiple') {
        const options = (entry && entry.question && entry.question.options) || [];
        const optionCap = Math.max(1, Number(options.length) || maxTake);
        let take = 1;
        while (take < Math.min(optionCap, maxTake) && isSingleLetterItem(data[cursor + take])) take++;
        // 多选至少要 2 项（除非这一批只够 1 项）
        if (take < 2 && maxTake >= 2 && isSingleLetterItem(data[cursor + 1])) take = 2;
        out.push(data.slice(cursor, cursor + take));
        cursor += take;
      } else {
        out.push(data[cursor]);
        cursor += 1;
      }
    }
    return cursor === data.length ? out : null;
  }

  function isSingleLetterItem(item) {
    return typeof item === 'string' && /^[A-Za-z]$/.test(item.trim());
  }

  /**
   * 模型在位置式输出末尾多吐一个选项字母时，保守地截掉它。
   *
   * 实测（2026-11-10 日志）：单题批 expected:1 / received:2，
   * 形如 ["实事求是、群众路线…","A"]。`resegmentFlatAnswers` 要求「所有项都被消费」，
   * 会把这种形状判成失败 → 整批丢弃 → 1~5 题的小卷整卷空着；补问一次仍是同样形状，
   * 用户看到的就是「连三五道题也不答了」。
   *
   * 只在三条同时成立时才采用：
   *   ① 多出来的尾部全是单字母选项；
   *   ② 前 N 项都能被 normalizeItem 识别（不是空值/错位）；
   *   ③ 本批没有多选题（多选被摊平由 resegmentFlatAnswers 负责）。
   * 其余任何形状仍整批丢弃 —— 历史教训：错位填空比留空重问更糟。
   */
  function trimTrailingOptionLetters(entries, data) {
    if (!Array.isArray(entries) || !Array.isArray(data)) return null;
    const n = entries.length;
    if (n < 1 || data.length <= n) return null;
    if (entries.some((e) => String((e && e.type) || '') === 'multiple')) return null;
    const tail = data.slice(n);
    if (!tail.every(isSingleLetterItem)) return null;
    const head = data.slice(0, n);
    try {
      if (!head.every((item) => !!PROMPT.normalizeItem(item))) return null;
    } catch (eNorm) { return null; }
    return head;
  }

  /**
   * 模型把**单选题**的选项字母多吐了一个时，把那一段连续字母并回同一题。
   *
   * 现场证据（2026-11-11，用户那份 20 题的卷子，日志里当场抄下来的原文）：
   *   `llm answer count mismatch, batch discarded (refill) {expected:3, received:4,
   *    excerpt:["A","D",true,"历史|||人民"]}`
   * —— 3 道题（单选 / 判断 / 填空）回了 4 项：真实答案**全在里面**，
   * 只是那道单选题被模型顺手写成了两个字母（它拿不定主意，把两个候选都吐了出来）。
   * 上面两个救法都够不着这种形状：
   *   - `resegmentFlatAnswers` 只把连续字母归给**多选**，而多选本来就独占一批；
   *   - `trimTrailingOptionLetters` 只切**尾部**，多余的字母在中间。
   * 于是整批丢弃 → 补问 → 同样形状 → 又丢弃。这份卷子最终 10 个批次被整批丢掉，
   * 用户看到的就是「填空题空的，单选题欠了几个」。
   *
   * 判据是**唯一解**，不是"看着像"：
   *   ① 本批没有多选（多选的摊平归 resegment 管）；
   *   ② 多出来的项数 ≤3，且被吸收的那一段**全是单字母**；
   *   ③ 把 surplus 个字母并给第 k 题后，**每一项都和该题的题型对得上**
   *      （单选=字母、判断=布尔或两字以内、填空/简答=非字母的非空文本）；
   *   ④ 满足①~③的 k **只有一个**。有两个就可能是在猜（例如相邻两题都是单选，
   *      并给谁都成立）—— 那种仍按原规则整批丢弃，宁可留空重问也不错位填答案。
   *
   * @returns {Array|null} 长度 === entries.length 的数组；分不出来返回 null
   */
  function absorbExtraOptionLetters(entries, data) {
    if (!Array.isArray(entries) || !Array.isArray(data)) return null;
    const n = entries.length;
    const surplus = data.length - n;
    if (n < 2 || surplus < 1 || surplus > 3) return null;
    if (entries.some((e) => String((e && e.type) || '') === 'multiple')) return null;

    function typeFits(entry, item) {
      const type = String((entry && entry.type) || '');
      if (item === null || item === undefined) return false;
      try { if (!PROMPT.normalizeItem(item)) return false; } catch (eNorm) { return false; }
      if (type === 'single') return isSingleLetterItem(item);
      if (type === 'judge') {
        return typeof item === 'boolean' || (typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 2);
      }
      // 填空 / 简答：不能是光一个选项字母（那是选择题的形状）
      return !isSingleLetterItem(item) && String(item).trim().length > 0;
    }

    const solutions = [];
    for (let k = 0; k < n; k++) {
      if (String((entries[k] && entries[k].type) || '') !== 'single') continue;
      const run = data.slice(k, k + 1 + surplus);
      if (run.length !== 1 + surplus) continue;
      if (!run.every(isSingleLetterItem)) continue;
      const cand = data.slice(0, k).concat([run[0]], data.slice(k + 1 + surplus));
      if (cand.length !== n) continue;
      if (!cand.every((item, i) => typeFits(entries[i], item))) continue;
      solutions.push(cand);
      if (solutions.length > 1) return null;   // 第二种成立 = 在猜，不采用
    }
    return solutions.length === 1 ? solutions[0] : null;
  }

  function parseLLMResponse(text, expectedCount) {
    const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // ⚠️ 前两个分支必须 **Array.isArray 才算成功**：JSON.parse 对裸 JSON 标量
    // （字符串/数字）也会成功 —— 批次定版 3 后，单题批的"一行一个 JSON 值"应答
    // 恰好就是一行裸字符串，这里若当成功返回，data 是字符串而非位置式数组，
    // 该题答案会被静默丢掉、补问两次同样失败（实测：简答题整题消失）。
    // 标量应答交给下面的分段分支按 expectedCount 解析成数组。
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return { success: true, data: parsed };
      // 裸标量：只有"单题批"（expectedCount === 1）时才可能是该题的答案 ——
      // 包成单元素数组交给下游（分段分支要求分隔符存在，单行应答到不了那里）。
      // 多题卷收到标量 = 模型答非所问，保持失败走重试。
      if (expectedCount === 1 &&
          (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean')) {
        return { success: true, data: [parsed] };
      }
    } catch (e) {}
    const code = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (code) {
      try {
        const parsed = JSON.parse(code[1].trim());
        if (Array.isArray(parsed)) return { success: true, data: parsed };
      } catch (e2) {}
    }
    // ⚠️ 顺序很关键：**按段解析必须排在贪婪 `[...]` 匹配之前**。
    // 因为像"一行一个 JSON 值"这种应答里通常**也**含一个合法的小数组
    // （多选那行的 `["A","C"]`），贪婪分支会先把它整段抓走并 JSON.parse 成功 ——
    // 于是返回一个**长度不对**的数组（实测：5 题的应答被解析成 2 项），
    // 下游只能靠"长度不符"来兜，白白丢掉正确答案。
    // 按段解析带**严格等长**判据，能用就用它；用不上才退回贪婪分支。
    const separators = ['\n', '|||'];
    for (let si = 0; si < separators.length; si++) {
      const separated = parseSeparatedAnswers(cleaned, separators[si], expectedCount);
      if (separated) {
        // 成功时**必须留一条日志**。这不是啰嗦：
        // 没有它，"这条兜底到底装上没有"只能靠猜 —— 实测就踩过，
        // 用户 reload 扩展的时间点早于改动落盘，日志里当然看不到效果，
        // 而两边都以为修好了（白跑一轮排查）。这条日志同时能告诉我们
        // 这种非标准形状出现的频率与样子。
        appendRuntimeLog('warn', 'llm answers parsed by separator', {
          separator: separators[si] === '\n' ? 'newline' : separators[si],
          count: separated.length,
          excerpt: cleaned.slice(0, 140)
        });
        return { success: true, data: separated };
      }
    }
    const array = cleaned.match(/\[[\s\S]*\]/);
    if (array) {
      try {
        return { success: true, data: JSON.parse(array[0]) };
      } catch (e3) {}
    }
    if (/^\s*\{/.test(cleaned)) {
      try {
        const obj = JSON.parse(cleaned);
        if (obj && (obj.answer != null || obj.a != null)) return { success: true, data: [obj] };
      } catch (e4) {}
    }
    // 数组残缺时逐对象捞取。同时认新短键 a 与旧键 answer（见 libs/prompt.js 的兼容说明）
    const objects = cleaned.match(/\{[^{}]*(?:"answer"|"a")\s*:[^{}]*\}/g);
    if (objects && objects.length) {
      try {
        const arr = objects.map((s) => JSON.parse(s)).filter((o) => o && (o.answer != null || o.a != null));
        if (arr.length) return { success: true, data: arr };
      } catch (e5) {}
    }
    return { success: false, error: `Unable to parse AI response: ${cleaned.slice(0, 200)}` };
  }

  async function apiFetch(url, options, timeoutMs) {
    if (await refreshPageScope() !== 'study') return { success: false, error: 'scope_denied' };
    const timeout = timeoutMs || 60000;
    const proxy = await sendRuntimeMessageWithTimeout({
      type: 'api_fetch',
      payload: {
        url,
        method: (options && options.method) || 'POST',
        headers: (options && options.headers) || {},
        body: (options && options.body) || '',
        timeoutMs: timeout
      }
    }, timeout + 15000, 'AI 请求超时 —— 网络不通，或服务商长时间无响应（不是配置错误）');

    if (proxy && proxy.success && typeof proxy.text === 'string') {
      return proxy;
    }
    if (proxy && proxy.status && typeof proxy.text === 'string') {
      return proxy;
    }

    // No direct fetch fallback: a worker rejection must not be bypassed in the isolated world.
    return proxy || { success: false, error: '后台请求失败 —— 无法把请求转发给服务商（网络不通或扩展刚被重载）' };
  }

  async function updateApiConnectionState(failed, reason, requestedConfig) {
    const expectedFingerprint = requestedConfig && requestFingerprints.get(requestedConfig);
    if (!expectedFingerprint || !scopeIsCurrent('study')) return;
    const response = await sendRuntimeMessageWithTimeout({
      type: 'config_patch',
      payload: { patch: { apiConnectionFailed: !!failed, apiConnectionError: failed ? String(reason || '').slice(0, 300) : '' }, expectedFingerprint }
    }, 5000, 'config patch timeout');
    // Never reload the latest config and attach the result of an older provider request to it.
    if (response && response.success && response.config && scopeIsCurrent('study')) configs = { ...response.config };
  }

  /**
   * 记录前缀缓存命中情况。
   *
   * DeepSeek 在 usage 里给 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
   * （命中部分按约 1/10 价计费）。命中率是"省 token 改动"是否真的有效的唯一证据：
   * 只看输入总长度会得出完全相反的结论 —— 我们曾经把提示词压到极短，
   * 输入是短了，但公共前缀短到无法被识别成缓存单元，于是每一分输入都按原价计费。
   *
   * 命中为 0 时给一条 warn，因为那说明请求前缀被什么东西打脏了
   * （提示词里混进了每次都变的内容，或重试时题目被从中间删掉）。
   */
  function logCacheUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    const hit = Number(usage.prompt_cache_hit_tokens);
    const miss = Number(usage.prompt_cache_miss_tokens);
    if (!isFinite(hit) && !isFinite(miss)) return; // 非 DeepSeek 服务不报这两个字段
    const hitTokens = isFinite(hit) ? hit : 0;
    const missTokens = isFinite(miss) ? miss : 0;
    const total = hitTokens + missTokens;
    const meta = {
      hit: hitTokens,
      miss: missTokens,
      hitRate: total ? Math.round(hitTokens / total * 100) + '%' : 'n/a'
    };
    if (total && hitTokens === 0) {
      const now = Date.now();
      if (!prefixMissLogAt || now - prefixMissLogAt > 300000) {
        prefixMissLogAt = now;
        appendRuntimeLog('warn', 'llm prefix cache all missed', {
          ...meta,
          suppressed: prefixMissSuppressed
        });
        prefixMissSuppressed = 0;
      } else {
        prefixMissSuppressed++;
      }
    } else {
      prefixMissSuppressed = 0;
      appendRuntimeLog('info', 'llm prefix cache', meta);
    }
  }

  /**
   * 记账：把一次请求的 token 消耗写进日志。
   *
   * 为什么必须做（尤其是视觉请求）：视觉请求的图占大头，而**图并不在提示词里** ——
   * logCacheUsage 只看 prompt_cache_* 字段，对图片 token 一无所知。
   * 于是出现了最糟的组合：用户在花钱、日志里一片安静、出了事也查不出原因。
   *
   * 这里把 input/output 总数记出来，带 tag 区分（text / captcha / vision），
   * 让用户在弹窗「查看日志」里就能看到每一类花了多少。
   */
  function logTokenUsage(usage, tag) {
    if (!usage || typeof usage !== 'object') return;
    const prompt = Number(usage.prompt_tokens);
    const completion = Number(usage.completion_tokens);
    if (!isFinite(prompt) && !isFinite(completion)) return; // 该服务不报用量
    const promptTokens = isFinite(prompt) ? prompt : 0;
    const completionTokens = isFinite(completion) ? completion : 0;
    appendRuntimeLog('info', 'llm usage', {
      tag: tag || 'text',
      in: promptTokens,
      out: completionTokens,
      total: promptTokens + completionTokens
    });
  }

  /**
   * 构造一个带 HTTP 状态码的错误。
   *
   * ⚠️ 带上 status 是为了让上层能分清「永久错误」和「可以重试的错误」——
   * 之前所有失败都走同一个 throw，上层一律当成网络故障，见 httpErrorIsPermanent 的说明。
   */
  function makeHttpError(prefix, response) {
    const status = response ? response.status : undefined;
    // 分类文案由 libs/api-error.js 统一给出（弹窗测试与页面日志同一套口径）：
    // 人看到「【类别】中文说明 —— 下一步」，AI/日志拿到 category 标签 + 服务商原话 + 状态码。
    // 分类只是翻译，不篡改证据 —— 原话永远原样保留在 human 文案里。
    const described = API_ERROR
      ? API_ERROR.describe(status, (response && response.text) || '')
      : { category: 'unknown', human: prefix + ' request failed (' + (status || 'network') + '): ' +
          String((response && (response.text || response.error)) || '').slice(0, 300) };
    const err = new Error(described.human);
    err.httpStatus = status;
    err.apiCategory = described.category;
    err.apiProvider = prefix;
    return err;
  }

  /**
   * 判断一个 HTTP 状态码是不是「重试也没用」的永久错误。
   *
   * 为什么必须区分（实测踩出来的，不是推断）：
   *   401 / 403 / 404 通常是「API Key 填错、没权限、模型名写错」，重试一万次也一样。
   *   而上层过去把它们一律当成网络故障 → 写 apiConnectionFailed →
   *   page.js 设 45 秒退避且每次续期。用户的真实体验是：
   *   **填错 Key 之后插件表现为"卡死、整卷跳过"，而不是告诉他 Key 错了。**
   *
   * 429（限流）除外 —— 等一会儿是真的能恢复，退避对它恰恰是正确的处理。
   * 5xx 是服务端自己的事，也可能恢复，同样归到可重试。
   */
  function httpErrorIsPermanent(status) {
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
  }

  async function callOpenAICompatibleAPI(config, questions) {
    const url = buildOpenAICompatibleUrl(config.apiUrl);
    const messages = [
      { role: 'system', content: buildSystemPrompt(config) },
      { role: 'user', content: PROMPT.buildUserPrompt(questions) }
    ];
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${normalizeApiKey(config.apiKey)}`
    };

    let maxTokens = Number(config.maxTokens) > 0 ? Number(config.maxTokens) : 8192;
    let tokenField = 'max_tokens';

    // 思考参数：按渠道白名单算一次（见 libs/thinking.js）。
    // 升级前这段写死成"只对 DeepSeek 加 thinking:{type:disabled}"，
    // 所以旧行为 = 现在的 'off' 档，老用户升级后没有任何变化。
    let thinkingParams = buildThinkingParams(config);
    let thinkingStripped = false;
    const thinkingSummary = THINKING ? THINKING.describe(config) : 'thinking module missing';

    for (let attempt = 0; attempt < 4; attempt++) {
      const body = { model: config.model, messages, temperature: 0.1 };
      body[tokenField] = maxTokens;
      // 思考参数合并进来。
      // ⚠️ 只发白名单里的字段：其他 OpenAI 兼容服务商对未知参数的反应不一致，
      // 有的忽略、有的直接 400，所以"不发"是安全默认（见 buildThinkingParams）。
      Object.assign(body, thinkingParams);
      const response = await apiFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }, 120000);

      if (response.success) {
        const firstChoice = (((response.data || {}).choices || [])[0] || {});
        const choice = firstChoice.message || {};
        // 把前缀缓存的命中情况记进日志。
        // 不记的话，"省 token 的改动是不是把缓存打没了"只能靠猜 ——
        // 我们真的这样翻过车：提示词压得太短，公共前缀无法被识别成缓存单元，
        // 命中率长期恒为 0，而界面上看不出任何异常。
        logCacheUsage((response.data || {}).usage);
        logTokenUsage((response.data || {}).usage, 'text');

        // 输出被 max_tokens 截断 —— 这**不是解析问题，而是答案根本没写完**。
        // 不单独识别它的代价（实测）：截断的文本解析必然失败 →
        // `requestAnswersWithRetry` 拿**同一批题**重问两次（同样的输入 → 同样的退化，
        // 一次吐出 8192 token 的重复数组）→ 再走"空答案补问"又两次 →
        // 一轮白烧六次输出上限，而题目一道都没答上。
        // 所以这里给它一个**独立的失败标记**：上层据此把批拆小再问，
        // 而不是拿原样的输入去撞同一面墙。
        if (isTruncatedFinishReason(firstChoice.finish_reason)) {
          appendRuntimeLog('warn', 'llm response truncated by max_tokens', {
            finishReason: String(firstChoice.finish_reason || ''),
            questions: questions.length
          });
          return { success: false, truncated: true, error: 'AI response truncated by max_tokens' };
        }
        return parseLLMResponse(choice.content || '', questions.length);
      }

      const errText = String(response.text || response.error || '').slice(0, 300);
      if (response.status === 400) {
        if (attempt === 0 && /max_tokens/i.test(errText) && /unsupported|not support|unknown|invalid|参数/i.test(errText)) {
          appendRuntimeLog('warn', 'llm max_tokens unsupported, retry with max_completion_tokens', {});
          tokenField = 'max_completion_tokens';
          continue;
        }
        if (/max_tokens|max_completion_tokens|token/i.test(errText) && /limit|exceed|too (large|big)|range|between|must be|参数/i.test(errText) && maxTokens > 1024) {
          appendRuntimeLog('warn', 'llm max_tokens out of range, retry lower', { maxTokens });
          maxTokens = Math.max(1024, Math.floor(maxTokens / 2));
          continue;
        }
        // 服务商不认这套思考参数（用户选了"低/高"档时最可能碰到）：
        // **摘掉它重试一次**，而不是把整次答题判死。
        // 不这么做的话，症状是"换了个模型就一直 400" —— 看起来像插件坏了。
        if (!thinkingStripped && Object.keys(thinkingParams).length &&
            /reasoning_effort|enable_thinking|thinking|unsupported|unknown|unexpected|extra|not support|invalid|参数|不支持/i.test(errText)) {
          thinkingStripped = true;
          thinkingParams = {};
          appendRuntimeLog('warn', 'llm rejected thinking params, retry without them', {
            error: errText.slice(0, 160),
            thinking: thinkingSummary
          });
          continue;
        }
      }
      throw makeHttpError('API', response);
    }
    throw new Error('API request failed after parameter retries');
  }

  async function callClaudeAPI(config, questions) {
    const url = buildClaudeApiUrl(config.apiUrl);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': normalizeApiKey(config.apiKey),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens || 8192,
        temperature: 0.1,
        system: buildSystemPrompt(config),
        messages: [{ role: 'user', content: PROMPT.buildUserPrompt(questions) }]
      })
    }, 120000);
    if (!response.success) throw makeHttpError('Claude', response);
    const content = (((response.data || {}).content || [])[0] || {}).text || '';
    // Claude 的截断标记是顶层 `stop_reason: "max_tokens"`（与 OpenAI 的
    // `choices[0].finish_reason` 不同名同义）。一律归一成 truncated 标记，
    // 上层的"拆批重问"才能对三个渠道一视同仁。
    if (isTruncatedFinishReason((response.data || {}).stop_reason)) {
      appendRuntimeLog('warn', 'llm response truncated by max_tokens', {
        provider: 'claude',
        finishReason: String((response.data || {}).stop_reason || ''),
        questions: questions.length
      });
      return { success: false, truncated: true, error: 'AI response truncated by max_tokens' };
    }
    return parseLLMResponse(content, questions.length);
  }

  async function callGeminiAPI(config, questions) {
    const apiKey = normalizeApiKey(config.apiKey);
    const url = buildGeminiApiUrl(config.apiUrl, config.model, apiKey);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(config) }] },
        contents: [{ role: 'user', parts: [{ text: PROMPT.buildUserPrompt(questions) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: config.maxTokens || 8192 }
      })
    }, 120000);
    if (!response.success) throw makeHttpError('Gemini', response);
    const firstCandidate = (((response.data || {}).candidates || [])[0] || {});
    const parts = (firstCandidate.content || {}).parts || [];
    // Gemini 的截断标记是 `candidates[0].finishReason === "MAX_TOKENS"`
    if (isTruncatedFinishReason(firstCandidate.finishReason)) {
      appendRuntimeLog('warn', 'llm response truncated by max_tokens', {
        provider: 'gemini',
        finishReason: String(firstCandidate.finishReason || ''),
        questions: questions.length
      });
      return { success: false, truncated: true, error: 'AI response truncated by max_tokens' };
    }
    return parseLLMResponse(parts.map((part) => part && part.text ? part.text : '').join('\n').trim(), questions.length);
  }

  async function callLLMProvider(config, questions) {
    if (config.apiType === 'claude') return callClaudeAPI(config, questions);
    if (config.apiType === 'gemini') return callGeminiAPI(config, questions);
    return callOpenAICompatibleAPI(config, questions);
  }

  async function requestAnswersWithRetry(config, questions) {
    let lastError = '';
    let lastWasNetwork = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callLLMProvider(config, questions);
        if (result && result.success) return result;
        // 被 max_tokens 截断：**换一批输入才有意义，重问同一批只会再撞一次天花板**
        // （模型退化成重复输出时，同样的提示词必然产生同样的退化）。
        // 直接交回给上层，由它把批拆小再问；这里多问一次就是白烧一次输出上限。
        if (result && result.truncated) return result;
        lastError = (result && result.error) || 'AI response parse failed';
        lastWasNetwork = false;
        appendRuntimeLog('warn', 'llm response parse failed' + (attempt === 0 ? ', retrying' : ''), { error: String(lastError).slice(0, 200) });
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);

        // 永久错误（401 Key 无效 / 403 无权限 / 404 模型名错）：**重试没有意义**，
        // 更不能写 apiConnectionFailed —— 那会让 page.js 进入 45 秒退避循环，
        // 把"配置填错了"伪装成"网络连不上、插件卡死"。
        // 这里直接跳出重试，把带分类的人话报错返回给用户去看。
        //
        // 「没钱」有两种报法：402 显式欠费（天然是 permanent），OpenAI 系报
        // 429 + insufficient_quota —— 按状态码属于可重试的 429，但给欠费做退避
        // 只会重复撞墙，还会把 apiConnectionFailed 写成 true（用户看到"连接失败"，
        // 去查网络而不是去充值）。所以余额类错误一律按永久处理。
        if (httpErrorIsPermanent(error && error.httpStatus) || error.apiCategory === 'balance') {
          appendRuntimeLog('error', 'llm_request rejected (permanent)', {
            status: error.httpStatus,
            category: error.apiCategory || '',
            error: lastError.slice(0, 300)
          });
          return { success: false, error: lastError, permanentError: true, errorCategory: error.apiCategory || '' };
        }

        lastWasNetwork = true;
        appendRuntimeLog('warn', 'llm request error' + (attempt === 0 ? ', retrying' : ''), { error: lastError.slice(0, 300) });
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (lastWasNetwork) {
      await updateApiConnectionState(true, lastError, config);
      appendRuntimeLog('error', 'llm_request direct failed', { error: lastError.slice(0, 300) });
      return { success: false, error: lastError };
    }
    return { success: false, error: lastError, parseError: true };
  }

  async function handleLLMRequestDirect(payload) {
    const questions = payload && payload.questions ? payload.questions : [];
    const config = await loadConfig();
    appendRuntimeLog('info', 'llm_request direct', {
      questionCount: questions.length,
      // 把"这次用的是哪家、什么思考强度、发了什么参数"记下来。
      // 换渠道出问题时，第一个要问的就是这个 —— 否则只能靠猜。
      thinking: THINKING ? THINKING.describe(config) : 'thinking module missing'
    });

    const missing = missingModuleError();
    if (missing) {
      appendRuntimeLog('error', 'llm_request aborted', { error: missing });
      return { success: false, error: missing };
    }
    if (!config.apiKey) return { success: false, error: 'Please configure API Key first' };
    if (!questions.length) return { success: false, error: 'no questions to answer' };

    // 分批请求。
    //
    // 批越大越省 token：system 提示词与输出格式示例是**每批都要重发**的固定开销
    // （约 85 token/批），而题目正文无论分成几批都只发一次。
    //
    // ⚠️ **2026-10-10 实测把"省固定开销"这条推翻了一半**：同一份 25 题的卷子
    // （10 多选 / 8 单选 / 5 判断 / 2 填空），每批 10 题时**第 2 批稳定退化**：
    //
    //   批1（10 题）out:34  ✅    批2（10 题）**out:8192** ❌ 顶满上限被截断
    //   批3（ 5 题）out:11  ✅    拆半后（5 题）out:49     ✅
    //
    // 退化一旦发生，代价是**一次 8192 输出**（比省下的固定开销贵十几倍），
    // 还会连带触发"拆批/补问/下一轮重来"的连锁开销 —— 于是从 10 降到 5。
    //
    // ⚠️ **2026-10-31 用户定版降到 3**：上下文压力下，难题多的批会整批退化
    // （截断/摊平/答非所问甚至整体拒答），一批废 = 这一整批的钱白花。
    // 用户原话："能接受慢，但不能接受快而没用还吃钱"。每批越小，
    // 一次退化的损失越小、补问越便宜 —— 慢一点换稳。
    const CHUNK_SIZE = 3;
    const chunks = [];
    const toChunkEntry = (question, origin) => {
      const raw = Number(question && question.index);
      return {
        origin: Number.isFinite(raw) && raw >= 0 ? raw : origin,
        type: (question && question.type) || 'single',
        question: question
      };
    };
    // 多选题**自己一批**，但**不连累同一批里的邻居**。
    //
    // 它答案最长、是整批退化的最大来源（摊平/截断实测元凶），单独成批后废了只废它自己。
    // ⚠️ 旧写法是"切片里只要有多选，整片拆成一题一批" —— 那在多选由 page 本地作答的年代
    //   成立：那时只有**重试轮**才把多选交回模型，"一题一请求"正是想要的。
    //   2026-11-10 批次 7 把多选改回**照常问模型**（本地乱猜的代价见 page.js 那段说明），
    //   于是"每 3 题里混进一道多选"会把另外两道无辜的题也拖成一题一批：
    //   固定开销（system 提示词 + 输出示例，约 85 token）是按**批**计的，
    //   一份 25 题、5 道多选的卷子要多花十几批的钱、多等十几轮往返。
    //   现在：多选随时单独成批，其余题继续凑满 CHUNK_SIZE 再发（多选不打断正在攒的那一批）。
    let pendingChunk = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (q && q.type === 'multiple') {
        chunks.push([toChunkEntry(q, i)]);
        continue;
      }
      pendingChunk.push(toChunkEntry(q, i));
      if (pendingChunk.length === CHUNK_SIZE) {
        chunks.push(pendingChunk);
        pendingChunk = [];
      }
    }
    if (pendingChunk.length) chunks.push(pendingChunk);

    const merged = [];
    const filled = new Set();
    // 因「长度不符」被整批丢弃的那些条目（按 origin 去重）。
    // 补问阶段要用它决定「还按原来的大小重问」还是「拆成一题一批重问」，见稍后那段说明。
    const discardedEntries = [];
    const discardedOrigins = new Set();
    let lastFailure = null;
    let permanentFailure = null;
    // 模型**到底有没有回过话**（哪怕内容不可用）。决定"要不要补问"时要用它：
    // `merged.length` 为空既可能是"API/网络坏了"（补问纯烧钱），
    // 也可能是"整批因长度不符被丢弃"（**这时补问是唯一的出路**：
    // 补问的批更小、条数更干净，实测正是这情形把整卷卡在最后 2 题上）。
    let sawResponse = false;

    // 把一次成功请求的返回按位置对齐合并进 merged。
    // 主批与"空答案补问"共用这一段，两处的对齐规则必须完全一致，
    // 所以抽成局部函数而不是复制粘贴。
    const mergeAnswers = (entries, result, label) => {
      // 位置式输出的前提是"数组长度 === 题目数"。**长度不符时一律整批不采用。**
      //
      // ⚠️ 原来这里是"尽力按位置对齐 + 只打一条 warning"。实测（2026-10-10）证明
      // 那个"可自愈的降级"根本不自愈，而是**现场卡死的直接原因**：
      //   5 题收到 13 项 → 前 5 项被硬塞给这 5 题，其中两道**填空题**拿到的是用不上的值
      //   → 插件以为"这批答完了"（content 侧的 filled 已满足）→ **不再补问** →
      //   可 DOM 里那两题是空的 → 表单永远不满 → 永不提交 → 整卷每 30 秒重来一轮。
      // 现在改成整批丢弃：这些题保持未答 → **由"空答案补问"重新问一次**
      // （补问的批更小、条数更干净，配上按段解析的"严格等长"判据，命中率高得多）。
      // 取舍与本仓库一贯一致：**宁可留空重问，也不要错位把答案填错题**。
      // ⚠️ 长度不符时**先试着贪心重分段**（见 `resegmentFlatAnswers` 的说明）：
      // 现场最常见的形状是"多选的字母被摊平"，答案其实全在，
      // 只是被摊成了一串。分不出来才整批丢弃（宁可留空重问，也不要错位填错题）。
      let items = result.data;
      if (result.data.length !== entries.length) {
        const resegmented = resegmentFlatAnswers(entries, result.data);
        if (resegmented) {
          appendRuntimeLog('warn', 'llm flat answers resegmented' + (label ? ' (' + label + ')' : ''), {
            expected: entries.length,
            received: result.data.length,
            excerpt: JSON.stringify(result.data).slice(0, 180)
          });
          items = resegmented;
        } else {
          const trimmed = trimTrailingOptionLetters(entries, result.data);
          if (trimmed) {
            appendRuntimeLog('warn', 'llm trailing option letters trimmed' + (label ? ' (' + label + ')' : ''), {
              expected: entries.length,
              received: result.data.length,
              excerpt: JSON.stringify(result.data).slice(0, 180)
            });
            items = trimmed;
          } else {
            // 第三种形状：多出来的字母**夹在中间**，前两个救法都够不着（见 `absorbExtraOptionLetters`）。
            // 现场那份 20 题的卷子有 10 个批次栽在这一格 —— 答案其实在，只是被丢弃。
            const absorbed = absorbExtraOptionLetters(entries, result.data);
            if (absorbed) {
              appendRuntimeLog('warn', 'llm extra option letters absorbed' + (label ? ' (' + label + ')' : ''), {
                expected: entries.length,
                received: result.data.length,
                excerpt: JSON.stringify(result.data).slice(0, 180)
              });
              items = absorbed;
            } else {
              entries.forEach((entry) => {
                const origin = entry && entry.origin;
                if (origin == null || discardedOrigins.has(origin)) return;
                discardedOrigins.add(origin);
                discardedEntries.push(entry);
              });
              appendRuntimeLog('warn', 'llm answer count mismatch, batch discarded' + (label ? ' (' + label + ')' : ''), {
                expected: entries.length,
                received: result.data.length,
                // 把收到的内容抄一小段：只报"几个对几个"没法判断是"被压平了"
                // 还是"回的是别的批次"，而这两种要修的完全不是一处。
                excerpt: JSON.stringify(result.data).slice(0, 220),
                // ⚠️ 题型也必须抄下来。现场那份 20 题的卷子连续两轮丢弃，收到的都是
                // `["A","D",true,"历史|||人民"]` —— 只看答案形状没法判"为什么三种救法
                // 都够不着"：同样一串答案，配 [单选,判断,填空] 能被 absorb 救回（itest [8b] 就是这么定的），
                // 配 [单选,单选,填空] 或 [单选,填空,判断] 则三种切法都错、必须丢弃。
                // 没有这一栏，下一轮修复只能靠猜题型。
                types: entries.map((entry) => String((entry && entry.type) || '?')).join(',')
              });
              return;
            }
          }
        }
      }

      items.forEach((item, position) => {
        const normalized = PROMPT.normalizeItem(item);
        if (!normalized) return;

        // 位置式输出没有 index，一律按 position 对齐；
        // 若模型仍回传了 index（旧的包装格式），优先信任 index，越界时退回 position。
        let slot = null;
        if (normalized.index != null && normalized.index < entries.length) {
          slot = entries[normalized.index];
        } else if (position < entries.length) {
          slot = entries[position];
        }
        if (!slot || filled.has(slot.origin)) return;

        filled.add(slot.origin);
        // type 取题目本身的实测结果而非模型自报值：_detectQuestionType 读的是真实 DOM，
        // 比模型复述更可靠，因此输出侧不需要回传 type（见 libs/prompt.js 的说明）。
        merged.push({
          index: slot.origin,
          type: slot.type,
          answer: coerceAnswerForType(normalized.answer, slot.type)
        });
      });
    };

    // 一批 → 答案，带**截断时对半拆**的兜底（最多拆两层）。
    //
    // 为什么拆真能救回来：截断的根因是"模型在这一批题上退化成长篇重复输出"，
    // 批越小越不容易退化；而拿原样的批重问是**必然重现**（实测六次顶满输出上限）。
    // ⚠️ 只对 `truncated` 拆 —— 普通解析失败/网络失败拆了也是白拆，还多花钱。
    const requestChunkWithSplit = async (entries, depth, labelOverride) => {
      if (permanentFailure) return false;
      const result = await requestAnswersWithRetry(config, entries.map((entry) => entry.question));
      if (result && result.permanentError) permanentFailure = result;
      if (result && result.success && Array.isArray(result.data)) {
        sawResponse = true;   // 有应答（即使随后因长度不符被整批丢弃）
        mergeAnswers(entries, result, labelOverride !== undefined ? labelOverride : (depth > 0 ? 'split' : ''));
        return true;
      }
      // 模型**有回应**、只是内容不可用（解析不了 / 被截断）——
      // 这也要记下来：后面决定"要不要补问"时，"API 坏了"和"内容不对"必须区别对待。
      if (result && (result.parseError || result.truncated)) sawResponse = true;
      if (result && result.truncated && entries.length > 1 && depth < 2) {
        appendRuntimeLog('warn', 'llm chunk truncated, splitting in half', {
          questions: entries.length,
          depth: depth,
          error: String(result.error || '').slice(0, 120)
        });
        const half = Math.ceil(entries.length / 2);
        const leftOk = await requestChunkWithSplit(entries.slice(0, half), depth + 1);
        const rightOk = await requestChunkWithSplit(entries.slice(half), depth + 1);
        return leftOk || rightOk;
      }
      lastFailure = result;
      return false;
    };

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      if (chunks.length > 1) {
        appendRuntimeLog('info', 'llm request chunk', { chunk: ci + 1, total: chunks.length, questions: chunk.length });
      }

      await requestChunkWithSplit(chunk, 0);
      if (permanentFailure) break;
    }

    // 空答案补问（token 优化的关键一环）：
    // 一轮跑完仍有题目没拿到答案（模型返回了空串/null、位置错位被丢弃）时，
    // 只把这些题打包成**一次**小请求重问，而不是放弃。
    //
    // 为什么值得：旧实现里这些题会落进 page.js `_avoidKnownWrongAnswer` 的
    // 空答案兜底（直接猜第一个选项）。判断题猜错概率 50%，一旦猜错，
    // 整卷会带着 `禁:` 前缀重答一遍——一次整卷重答约几百 token、
    // 还多一轮"填→提交→判错"的页面往返；而这里补问通常只有一两百 token，
    // 把"猜"换成"问"，正确率和成本同时改善。
    //
    // 补问条件：**还有题没拿到答案**，而且**模型确实回过话**。
    // ⚠️ 这里从"只在部分成功时补问"（`merged.length`）改成"有回应就补问"：
    // 整批因长度不符被丢弃时 `merged` 是空的，旧条件会**连补问都不做** ——
    // 那是一条死路（现场就是整卷卡在最后 2 题上、每 30 秒重来一轮）。
    // 判据用 `sawResponse` 而不是 `merged.length`：它区分的是
    // "API/网络坏了"（补问纯烧钱，走原失败分支）与"内容不对"（补问是唯一出路）。
    if (!permanentFailure && filled.size < questions.length && sawResponse) {
      const unfilled = [];
      chunks.forEach((chunk) => {
        chunk.forEach((entry) => {
          if (!filled.has(entry.origin)) unfilled.push(entry);
        });
      });
      if (unfilled.length) {
        // ===== 丢弃过的那一批，补问时改成**一题一问** =====
        //
        // 现场（2026-11-11 真页面，20 题卷子）：第 7 批 3 题回 4 项 `["A","D",true,"历史|||人民"]`
        // 被整批丢弃，补问按同样的 3 题再问一次 —— **回了一模一样的 4 项**，又丢弃一次。
        // 三种对齐救法（resegment / trim / absorb）都够不着这种形状（多出来的不是尾部字母，
        // 而是夹着一个本题型接不住的值），最后只能由页面侧的占位兜底"猜"上，
        // 用户看到的"单选题欠了几个"就是这么欠的。
        //
        // 判据不靠猜对齐，靠**把批缩小到没有歧义**：一题一批时模型只会回这一题的答案，
        // 长度对不上就只剩"多吐了一个字母"一种形状 —— 而那正是 trim 能救的。
        // 同一份卷子里那 5 道多选（本来就单独成批）回话被摊平成 4~6 项，
        // **5 次全被 resegment 救回、零丢弃**，就是这条取舍的实测依据。
        //
        // 代价与上界：固定开销按批计（约 85 token/批），所以只在
        //   ① 这些题确实**来自被丢弃的批次**（不是"网络坏了""答了空串"那些），
        //   ② 题数 ≤ 6
        // 时才拆；再多就退回原来的"一次打包重问"，不让一份大题的补问变成请求洪水。
        const allFromDiscard = discardedEntries.length > 0 &&
          unfilled.every((entry) => discardedOrigins.has(entry.origin));
        if (allFromDiscard && unfilled.length > 1 && unfilled.length <= 6) {
          appendRuntimeLog('info', 'llm refill split per question', {
            count: unfilled.length,
            total: questions.length,
            types: unfilled.map((entry) => String((entry && entry.type) || '?')).join(','),
            hint: '这些题上一轮因长度不符被整批丢弃，同样的批重问会回同样的形状（实测两轮一模一样），' +
              '所以改成一题一问：单题批没有"错位给隔壁题"的歧义，救得回来的概率高得多'
          });
          for (const entry of unfilled) {
            if (permanentFailure) break;
            await requestChunkWithSplit([entry], 0, 'refill-one');
          }
        } else {
          appendRuntimeLog('info', 'llm refill unanswered', {
            count: unfilled.length,
            total: questions.length
          });
          const refill = await requestAnswersWithRetry(config, unfilled.map((entry) => entry.question));
          if (refill && refill.permanentError) permanentFailure = refill;
          if (refill && refill.success && Array.isArray(refill.data)) {
            mergeAnswers(unfilled, refill, 'refill');
          } else {
            appendRuntimeLog('warn', 'llm refill failed, leave for next tick', {
              count: unfilled.length,
              // 把"是不是被截断"单列出来：这两种失败的处理完全不同
              // （截断要拆批，解析失败要改格式），日志混在一起就分不清该修哪边。
              truncated: !!(refill && refill.truncated),
              error: String((refill && refill.error) || '').slice(0, 160)
            });
          }
        }
      }
    }

    if (permanentFailure) return { ...permanentFailure, data: merged, partial: merged.length > 0 };
    if (merged.length) {
      if (lastFailure) {
        appendRuntimeLog('warn', 'llm partial chunk failure', {
          answered: merged.length,
          error: String(lastFailure.error || '').slice(0, 160)
        });
      }
      await updateApiConnectionState(false, null, config);
      return { success: true, data: merged };
    }
    return lastFailure || { success: false, error: 'LLM request failed' };
  }

  async function handleCaptchaRequestDirect(payload) {
    if (await refreshPageScope() === 'none') return { success: false, error: 'scope_denied' };
    // The worker owns saved provider credentials, request construction, and the sole OCR prompt.
    const response = await sendRuntimeMessageWithTimeout({ type: 'captcha_fetch', payload: { image: payload && payload.image } }, 105000, 'captcha request timeout');
    if (response && response.usage) logTokenUsage(response.usage, 'captcha');
    return response;
  }

  // 视觉理解提示词：题目带图时用。
  //
  // ⚠️ 故意**不**要求模型看懂整张图，而是要求它把图里影响作答的关键信息转成文字。
  // 理由：我们真正要的是「这道题选什么」，中间那步描述越短越省钱，
  // 也让主答题链的提示词保持纯文本 —— 前缀缓存不会被图片打散。
  const VISION_PROMPT = '这是一道题目的配图。用最简文字说明图中影响作答的关键信息（图形/数值/标签/关系），不要解释、不要复述题面。若图中没有对作答有用的信息，只输出：无。';

  /**
   * 视觉请求：把图里的信息转成文字，交回页面侧使用。
   *
   * 与 handleCaptchaRequestDirect 的分工：那个是「输出答案」，这个是「输出描述」。
   * 三条多模态协议分支（Claude / Gemini / OpenAI 兼容）复用同一套写法，
   * 避免出现第三份各自演化的实现。
   *
   * 成本是这里的第一约束：
   *   - 只接受调用方已筛过的图（张数/体积由页面侧的预算闸门控制）
   *   - 每次调用都记账（logTokenUsage），让用户能看见花了多少
   *   - 失败立刻返回，**不做任何重试** —— 重试等于再花一次钱
   */
  async function handleVisionRequestDirect(payload) {
    const images = payload && Array.isArray(payload.images) ? payload.images : [];
    if (!images.length) return { success: false, error: 'no images' };

    const config = await loadConfig();
    const missing = missingModuleError();
    if (missing) {
      appendRuntimeLog('error', 'llm_vision aborted', { error: missing });
      return { success: false, error: missing };
    }
    if (!config.apiKey) return { success: false, error: 'Please configure API Key first' };

    // 模型挑选顺序：visionModel（专为看图标）→ captchaModel（老用户可能已配好）→ model。
    // 最后一档回落有风险（文本模型多半看不懂图），但**不在这里静默降级** ——
    // 页面侧会在开启视觉时提示用户单独指定一个支持图片的模型。
    const model = String(config.visionModel || config.captchaModel || '').trim() || config.model;

    // 逐张解析；任何一张格式不合法就整体拒绝。
    // 不做「跳过坏图继续发」：那会变成发 N-1 张却按 N 张计费，账对不上。
    const parsed = [];
    for (let i = 0; i < images.length; i++) {
      const dataUrl = String(images[i] || '');
      const m = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.*)$/);
      if (!m) {
        appendRuntimeLog('warn', 'vision image rejected (bad format)', { index: i });
        return { success: false, error: 'unsupported image format at index ' + i };
      }
      parsed.push({ mediaType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], base64: m[2] });
    }

    appendRuntimeLog('info', 'vision llm request', { model: model, images: parsed.length });
    try {
      let text = '';
      let usage = null;

      if (config.apiType === 'claude') {
        const url = buildClaudeApiUrl(config.apiUrl);
        const content = [{ type: 'text', text: VISION_PROMPT }];
        parsed.forEach(function (p) { content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } }); });
        const response = await apiFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': normalizeApiKey(config.apiKey),
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 1024,
            temperature: 0,
            messages: [{ role: 'user', content: content }]
          })
        }, 90000);
        if (!response.success) throw new Error('Claude vision failed (' + (response.status || 'network') + '): ' + String(response.text || response.error || '').slice(0, 200));
        usage = (response.data || {}).usage || null;
        text = (((response.data || {}).content || [])[0] || {}).text || '';
      } else if (config.apiType === 'gemini') {
        const url = buildGeminiApiUrl(config.apiUrl, model, normalizeApiKey(config.apiKey));
        const parts = [{ text: VISION_PROMPT }];
        parsed.forEach(function (p) { parts.push({ inline_data: { mime_type: p.mediaType, data: p.base64 } }); });
        const response = await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: parts }],
            generationConfig: { temperature: 0, maxOutputTokens: 1024 }
          })
        }, 90000);
        if (!response.success) throw new Error('Gemini vision failed (' + (response.status || 'network') + '): ' + String(response.text || response.error || '').slice(0, 200));
        usage = (response.data || {}).usageMetadata || null;
        const respParts = ((((response.data || {}).candidates || [])[0] || {}).content || {}).parts || [];
        text = respParts.map(function (part) { return part && part.text ? part.text : ''; }).join('\n').trim();
      } else {
        const url = buildOpenAICompatibleUrl(config.apiUrl);
        const content = [{ type: 'text', text: VISION_PROMPT }];
        parsed.forEach(function (p) { content.push({ type: 'image_url', image_url: { url: 'data:' + p.mediaType + ';base64,' + p.base64 } }); });
        const response = await apiFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + normalizeApiKey(config.apiKey)
          },
          body: JSON.stringify({
            model: model,
            temperature: 0,
            max_tokens: 1024,
            messages: [{ role: 'user', content: content }]
          })
        }, 90000);
        if (!response.success) throw new Error('API vision failed (' + (response.status || 'network') + '): ' + String(response.text || response.error || '').slice(0, 200));
        usage = (response.data || {}).usage || null;
        text = ((((response.data || {}).choices || [])[0] || {}).message || {}).content || '';
      }

      // 无论成败都记账 —— 失败的请求同样产生费用（图已经传上去了）。
      if (usage) {
        logTokenUsage({
          prompt_tokens: usage.prompt_tokens !== undefined ? usage.prompt_tokens : usage.input_tokens,
          completion_tokens: usage.completion_tokens !== undefined ? usage.completion_tokens : usage.output_tokens
        }, 'vision');
      }

      text = String(text || '').trim();
      if (!text) return { success: false, error: 'empty vision result (check model vision support)' };
      return { success: true, data: text };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      appendRuntimeLog('error', 'vision request failed', { error: message.slice(0, 300) });
      return { success: false, error: message };
    }
  }

  function ensureStatusPanel() {
    if (statusPanel && statusPanel.host && statusPanel.host.isConnected) return statusPanel;
    if (!document.body) return null;

    const oldHost = document.getElementById(STATUS_PANEL_ID);
    if (oldHost) oldHost.remove();

    const host = document.createElement('div');
    host.id = STATUS_PANEL_ID;
    host.style.cssText = [
      'all:initial',
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'width:280px',
      'max-width:calc(100vw - 36px)',
      'pointer-events:none'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.card{box-sizing:border-box;width:100%;border:1px solid rgba(15,23,42,.12);border-radius:16px;background:rgba(255,255,255,.96);box-shadow:0 18px 50px rgba(15,23,42,.22);color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:13px 14px;pointer-events:auto;backdrop-filter:blur(14px)}',
      '.head{display:flex;align-items:center;gap:8px;margin-bottom:9px}',
      '.brand{font-size:13px;font-weight:800;letter-spacing:.2px}',
      '.dot{width:8px;height:8px;border-radius:999px;background:#16a34a;box-shadow:0 0 0 4px rgba(22,163,74,.14)}',
      '.badge{margin-left:auto;border-radius:999px;padding:3px 8px;background:#dcfce7;color:#166534;font-size:11px;font-weight:800;white-space:nowrap}',
      '.close{margin-left:2px;border:0;background:transparent;color:#94a3b8;cursor:pointer;font-size:16px;line-height:16px;padding:2px}',
      '.task{font-size:14px;font-weight:800;line-height:1.45;color:#0f172a}',
      '.detail{margin-top:4px;font-size:12px;line-height:1.45;color:#64748b;word-break:break-word}',
      '.time{margin-top:8px;font-size:10px;color:#94a3b8}',
      '.card[data-state="wait"] .dot{background:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.14)}',
      '.card[data-state="wait"] .badge{background:#dbeafe;color:#1d4ed8}',
      '.card[data-state="warn"] .dot{background:#d97706;box-shadow:0 0 0 4px rgba(217,119,6,.14)}',
      '.card[data-state="warn"] .badge{background:#fef3c7;color:#92400e}',
      '.card[data-state="error"] .dot{background:#dc2626;box-shadow:0 0 0 4px rgba(220,38,38,.14)}',
      '.card[data-state="error"] .badge{background:#fee2e2;color:#991b1b}',
      '@media (max-width:520px){.card{border-radius:14px}.task{font-size:13px}}',
      '</style>',
      '<div class="card" data-state="normal">',
      '  <div class="head">',
      '    <span class="dot"></span>',
      '    <span class="brand">Omitone 1.3.0</span>',
      '    <span class="badge" data-role="state">正常运行</span>',
      '    <button class="close" type="button" title="隐藏状态窗">×</button>',
      '  </div>',
      '  <div class="task" data-role="task">等待启动</div>',
      '  <div class="detail" data-role="detail">准备接收运行状态</div>',
      '  <div class="time" data-role="time">--:--:--</div>',
      '</div>'
    ].join('');

    document.body.appendChild(host);

    statusPanel = {
      host,
      card: shadow.querySelector('.card'),
      state: shadow.querySelector('[data-role="state"]'),
      task: shadow.querySelector('[data-role="task"]'),
      detail: shadow.querySelector('[data-role="detail"]'),
      time: shadow.querySelector('[data-role="time"]'),
      close: shadow.querySelector('.close')
    };

    statusPanel.close.addEventListener('click', () => {
      statusPanelActive = false;
      statusLastSignature = '';
      host.remove();
      statusPanel = null;
    });

    return statusPanel;
  }

  function formatStatusTime() {
    try {
      return new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      return new Date().toTimeString().slice(0, 8);
    }
  }

  function setStatusPanel(state, task, detail) {
    if (!statusPanelActive) return;
    const panel = ensureStatusPanel();
    if (!panel) return;

    const stateKey = state || 'normal';
    const labels = {
      normal: '正常运行',
      wait: '等待中',
      warn: '注意',
      error: '异常运行'
    };
    const taskText = String(task || '运行中').slice(0, 80);
    const detailText = String(detail || '').slice(0, 220);
    const signature = [stateKey, taskText, detailText].join('|');
    if (signature === statusLastSignature) return;
    statusLastSignature = signature;

    panel.card.setAttribute('data-state', stateKey);
    panel.state.textContent = labels[stateKey] || labels.normal;
    panel.task.textContent = taskText;
    panel.detail.textContent = detailText || '状态更新中';
    panel.time.textContent = '更新于 ' + formatStatusTime();
  }

  function showStatusPanel(state, task, detail) {
    statusPanelActive = true;
    setStatusPanel(state || 'normal', task || '运行中', detail || '');
  }

  function jobKindLabel(kind) {
    const labels = {
      video: '视频播放',
      quiz: '测验答题',
      read: '阅读任务',
      document: '文档/PPT',
      timereader: '定时阅读',
      'ppt-audio': 'PPT 音频',
      hyperlink: '链接任务',
      other: '其他任务'
    };
    return labels[kind] || kind || '任务';
  }

  function runtimeLogToStatus(level, message, meta) {
    const msg = String(message || '');
    const data = meta || {};
    let state = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'normal');
    let task = '运行中';
    let detail = '状态更新中';

    if (msg === 'start') {
      task = '已启动';
      detail = '正在检测当前章节任务';
    } else if (/chapter changed|learning card changed/.test(msg)) {
      state = 'wait';
      task = '章节/任务卡片切换中';
      detail = '正在重新识别任务点';
    } else if (/study begin/.test(msg)) {
      state = 'wait';
      task = '扫描任务点';
      detail = '附件数：' + (data.attachments == null ? '-' : data.attachments);
    } else if (/study matched job/.test(msg)) {
      task = '执行任务：' + jobKindLabel(data.kind);
      detail = '任务处理中';
    } else if (/media pending|waiting for element/.test(msg)) {
      state = 'wait';
      task = '视频播放中';
      detail = '等待视频播放完成';
    } else if (/media play interrupted by site player/.test(msg)) {
      // 站点播放器自己抢了一下方向盘，插件下一拍会重新接上 —— 不能报「异常运行」
      state = 'wait';
      task = '视频播放中';
      detail = '站点播放器打断了一下，正在重新接上';
    } else if (/media play failed/.test(msg)) {
      state = 'error';
      task = '视频播放失败';
      detail = (data.error || '请在查看日志中确认详情');
    } else if (/managed media job ended/.test(msg)) {
      task = '视频任务完成';
      detail = '准备继续后续任务';
    } else if (/chaoxing read runner|document page|timereader/.test(msg)) {
      state = 'wait';
      task = '文档/PPT 处理中';
      detail = data.totalPages ? ('第 ' + data.currentPage + '/' + data.totalPages + ' 页') : '正在处理阅读任务';
    } else if (/document done|read finishJob/.test(msg)) {
      task = '文档/PPT 已完成';
      detail = '准备继续后续任务';
    } else if (/quiz submit pending/.test(msg)) {
      state = 'wait';
      task = '等待测验提交';
      detail = '等待提交结果';
    } else if (/quiz submit finished|quiz already finished|study quiz fallback completed/.test(msg)) {
      task = '测验任务完成';
      detail = '准备继续后续任务';
    } else if (/captcha detected, recognizing|captcha llm request/.test(msg)) {
      state = 'warn';
      task = '检测到验证码';
      detail = '正在通过 AI 识别图片字符';
    } else if (/captcha code filled/.test(msg)) {
      state = 'wait';
      task = '验证码识别完成';
      detail = '已填入并提交，等待校验结果';
    } else if (/captcha solved/.test(msg)) {
      task = '验证码已通过';
      detail = '继续学习流程';
    } else if (/captcha recognize failed|captcha image capture failed|captcha request failed|captcha code empty/.test(msg)) {
      state = 'error';
      task = '验证码识别失败';
      detail = (data.error || data.raw || '请检查模型是否支持图片输入');
    } else if (/captcha seems wrong, will retry/.test(msg)) {
      state = 'warn';
      task = '验证码校验未过';
      detail = '第 ' + (data.attempt || 1) + ' 次，将换图重试';
    } else if (/captcha unsolved, reload page|captcha wrong too many times/.test(msg)) {
      state = 'warn';
      task = '验证码多次未通过';
      detail = '正在刷新页面并自动继续';
    } else if (/llm_request rejected \(permanent\)|rejected permanently, no retry/.test(msg)) {
      state = 'warn';
      task = 'AI 服务商拒绝请求';
      // data.error 现在自带分类（【账户余额不足】/【API Key 无效】…），直接展示
      detail = (data.error || '检查 API Key、账户余额与模型名');
    } else if (/api connection failed|api unavailable|skip quiz because api unavailable|skip popup quiz because api unavailable/.test(msg)) {
      state = 'warn';
      task = 'API 不可用，跳过答题';
      detail = (data.error || data.reason || '未填写 API，或网络连不上服务商');
    } else if (/llm request error|llm_request direct failed/.test(msg)) {
      state = 'warn';
      task = 'AI 请求出错';
      detail = (data.error || '请求失败，正在重试');
    } else if (/llm response parse failed/.test(msg)) {
      state = 'warn';
      task = 'AI 返回解析失败';
      detail = (data.error || '正在重试');
    } else if (/llm request chunk/.test(msg)) {
      state = 'wait';
      task = 'AI 分批答题中';
      detail = '第 ' + (data.chunk || '-') + '/' + (data.total || '-') + ' 批（' + (data.questions || 0) + ' 题）';
    } else if (/llm partial chunk failure/.test(msg)) {
      state = 'warn';
      task = '部分题目请求失败';
      detail = '已答 ' + (data.answered || 0) + ' 题：' + (data.error || '');
    } else if (/quiz llm parse failed|popup quiz llm parse failed/.test(msg)) {
      state = 'warn';
      task = '答案解析失败，稍后重试';
      detail = (data.error || '');
    } else if (/study no runnable job|no runnable job|waiting task|search job:/.test(msg)) {
      state = state === 'warn' ? 'warn' : 'wait';
      task = '等待任务识别';
      detail = '正在等待可执行任务';
    } else if (/study finished on page/.test(msg)) {
      task = '页面任务完成';
      detail = '准备进入下一节';
    } else if (/study next unit|switch learning card/.test(msg)) {
      task = '切换下一节/任务卡片';
      detail = '正在切换';
    } else if (/skip completed/.test(msg)) {
      task = '当前章节已完成';
      detail = '已跳过重复学习';
    } else if (/media has no source, release pending/.test(msg)) {
      state = 'warn';
      task = '视频没能播放';
      detail = '这一节的视频始终没拿到地址，已停止等待并继续';
    } else if (/main frame unreadable|main frame document unreadable/.test(msg)) {
      state = 'warn';
      task = '页面内容读不到';
      detail = '这一页的任务点暂时做不了，下一步写在日志里';
    } else if (/veto window spent|parse retry spent|hold spent|given up \(stuck without progress\)|declined:/.test(msg)) {
      state = 'warn';
      task = '放弃等待，继续往下';
      detail = '这一处没有进展，原因写在这一条日志里';
    } else if (level === 'error') {
      task = '异常运行';
      detail = data.message || '请在查看日志中确认详情';
    } else if (level === 'warn') {
      // 没点名的 warn 以前退回「运行中 / 状态更新中」—— 那两句会把「注意」这个点自己抵消掉
      task = '有情况';
      detail = '可在「查看日志」里看这一条';
    }

    return { state, task, detail };
  }

  // ── 刷课活跃时长（角色小游戏「好感度」的数据源）──────────────────────
  // 信号源就是 runtime_log 消息流本身：插件在跑、页面是学习页，才有消息进来。
  // 纯读侧 + 20 秒节流落盘（libs/study-stats.js），任何失败都静默吞掉 ——
  // 它喂的是角色好感度，绝不能反过来影响刷课（与 pet 的零耦合原则同向：只读、可坏、无害）。
  let studyStatsState = null;
  let studyStatsWriting = false;
  function recordStudyActivity() {
    try {
      if (!STUDY_STATS) return;
      ensurePagePet();   // 懒挂载：角色伴侣随第一条运行日志出现（页面被站点脚本清掉也会自动补）
      const nowMs = Date.now();
      const result = STUDY_STATS.recordActivity(studyStatsState, nowMs);
      studyStatsState = result.state;
      if (STUDY_STATS.shouldFlush(studyStatsState) && !studyStatsWriting) {
        studyStatsWriting = true;
        const toWrite = STUDY_STATS.markFlushed(studyStatsState, nowMs);
        chrome.storage.local.set({ omitoneStudyStats: toWrite }, function () {
          studyStatsWriting = false;
          if (!chrome.runtime.lastError) studyStatsState = toWrite;
        });
      }
    } catch (e) { /* 游戏统计失败不影响任何功能 */ }
  }
  try {
    chrome.storage.local.get('omitoneStudyStats', function (r) {
      if (!chrome.runtime.lastError && r && r.omitoneStudyStats) studyStatsState = r.omitoneStudyStats;
    });
  } catch (e) { /* storage 不可用就当没有历史 */ }

  // ── 上课页角色伴侣（小游戏的页面端）────────────────────────────────────
  // 刷课时人盯着的是学习页，弹窗一合角色就没了 —— 把她带到页面上来。
  // 与状态面板同一套纪律：
  //   · 样式进 Shadow DOM（与状态面板一致）：学习通的 CSS 进不来、我们的样式漏不出
  //     —— 不会错位、不会被站点样式冲掉；@keyframes 也定义在 shadow 里防同名互踩；
  //     继承属性（字体/颜色/行高）会穿过 shadow 边界，在 wrap 上显式重置；
  //   · 任何一步失败都只表现为"她没出现"，绝不影响刷课；
  //   · 只读刷课统计、只写好感度存档（omitonePetBond，与弹窗共享），与调度零耦合。
  const PAGE_PET_ID = 'omitone-page-pet-host';
  const PAGE_PET_HIDDEN_KEY = 'omitonePagePetHidden';
  // 拖动后的位置（{x,y} = 宿主左上角，CSS 像素）。和"收起"一样是**纯外观存档**：
  // 读不到就用默认锚点，写失败也只是下次还在老地方。
  const PAGE_PET_POS_KEY = 'omitonePagePetPos';
  const BOND_STORAGE_KEY = 'omitonePetBond';
  let pagePet = null;
  let pagePetBond = null;
  let pagePetSayTimer = null;
  // 自动台词（她的"自言自语"）与上一次开口的时刻。开口时刻记在宿主元素的 data 上（见 pagePetSay），
  // 这里只留一个常量：两句自动台词之间的最小间隔，比弹窗里任何一次操作都长得多。
  const PAGE_PET_IDLE_MIN_GAP_MS = 75000;
  let pagePetIdleTimer = null;

  function petGameModule() {
    return (typeof self !== 'undefined' && self.OmitonePetGame) || null;
  }

  function persistPagePetBond() {
    try {
      const patch = {};
      patch[BOND_STORAGE_KEY] = pagePetBond;
      chrome.storage.local.set(patch, function () { void chrome.runtime.lastError; });
    } catch (e) {}
  }

  function renderPagePet() {
    if (!pagePet || !pagePetBond) return;
    const game = petGameModule();
    if (!game) return;
    try {
      const lv = game.levelOf(pagePetBond.affection);
      const levelDef = game.LEVELS[lv] || game.LEVELS[0];
      const nextDef = game.LEVELS[lv + 1];
      const pct = nextDef
        ? Math.round((pagePetBond.affection - levelDef.min) / Math.max(1, nextDef.min - levelDef.min) * 100)
        : 100;
      pagePet.els.bondBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      pagePet.els.level.textContent = levelDef.name;
      pagePet.els.level.title = '好感度 ' + pagePetBond.affection + ' / ' + game.RULES.max +
        (nextDef ? '（下一级「' + nextDef.name + '」还差 ' + (nextDef.min - pagePetBond.affection) + ' 点）' : '（已满）');
    } catch (e) {}
  }

  // 「她刚才开口了」记在**宿主元素的 data** 上，而不是闭包变量里 ——
  // 自动台词那条"刚说过就别再说"要靠它判，而 e2e 从页面世界看不见闭包。
  // 只写自己宿主上的一个属性，不碰存档、不碰调度。
  function pagePetSaid() {
    try { if (pagePet) pagePet.host.dataset.saidAt = String(Date.now()); } catch (e) {}
  }

  function pagePetLastSaidMs() {
    try { return Number(pagePet && pagePet.host.dataset.saidAt) || 0; } catch (e) { return 0; }
  }

  function pagePetSay(text, ms) {
    if (!pagePet) return;
    try {
      const bubble = pagePet.els.bubble;
      const clean = String(text || '');
      pagePetSaid();
      // 长句在卡片里最多 4 行（CSS 已限 max-height）；这里再兜一刀，
      // 免得某条成就文案把气泡撑成一块挡板（用户说的"一大坨"）。
      // ⚠️ 上限按**卡片实际能装多少字**定：内容宽 224-22≈200px、一行约 16 个汉字、5 行 ——
      //   96 字那时已经有 6 行，最后一行被 max-height 裁成半截，看起来更乱。
      bubble.textContent = clean.length > 60 ? clean.slice(0, 57) + '…' : clean;
      // 靠哪边的屏幕边缘，气泡就往反方向长 —— 否则贴右边缘时右半边直接出界。
      const base = pagePet.els.card || pagePet.els.wrap;
      const rect = base.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      bubble.classList.toggle('side-right', center >= window.innerWidth / 2);
      bubble.classList.toggle('side-left', center < window.innerWidth / 2);
      bubble.classList.add('show');
      clearTimeout(pagePetSayTimer);
      const hold = ms || (clean.length > 40 ? 4200 : 2600);
      pagePetSayTimer = setTimeout(function () {
        try { bubble.classList.remove('show'); } catch (e) {}
      }, hold);
    } catch (e) {}
  }

  /** 她自己开口说一句。定时器和 e2e 都调这个，**该不该说**全在这里判。
   *  @returns {string} 真说出来的台词；空串 = 这一拍不该说话。
   *  ⚠️ 四条"别说"少任何一条，都会变成用户讨厌的那个东西：
   *    · 标签页在后台 —— 看不见还在说，切回来时一堆排着队跳出来；
   *    · 已被收起 —— 那是用户明确表达过"别在这儿"；
   *    · 正被拖着走 —— 气泡会跟着乱跳；
   *    · 刚说过话（含摸头/升级/成就）—— 自动台词永远排在真人互动之后。 */
  function pagePetIdleSay() {
    if (!pagePet || !pagePetBond) return '';
    try {
      if (document.hidden) return '';
      if (pagePet.els.wrap.classList.contains('mode-hidden')) return '';
      if (pagePet.els.card.classList.contains('dragging')) return '';
      if (Date.now() - pagePetLastSaidMs() < PAGE_PET_IDLE_MIN_GAP_MS) return '';
      const game = petGameModule();
      const pool = (game && game.IDLE_LINES) || [];
      const line = String(pool[Math.floor(Math.random() * pool.length)] || '');
      if (!line) return '';
      pagePetSay(line, 3200);
      return line;
    } catch (e) { return ''; }
  }

  function pagePetHearts(clientX, clientY) {
    if (!pagePet) return;
    try {
      // ⚠️ 心形是 append 到 wrap 里的**绝对定位**元素，坐标必须以 wrap 左上角为原点。
      //    原先直接把 `ev.clientX/clientY`（**视口**坐标）当 left/top 写进去 ——
      //    在 1699 宽的屏上等于把她扔到 wrap 外一千多像素处，于是"点了她一下什么也没发生"。
      const base = pagePet.els.wrap.getBoundingClientRect();
      const ox = (Number(clientX) || 0) - base.left;
      const oy = (Number(clientY) || 0) - base.top;
      for (let i = 0; i < 4; i++) {
        const h = document.createElement('span');
        h.className = 'heart';
        h.textContent = '❤';
        h.style.left = Math.round(ox + (Math.random() * 26 - 13)) + 'px';
        h.style.top = Math.round(oy + (Math.random() * 10 - 5)) + 'px';
        pagePet.els.wrap.appendChild(h);
        setTimeout(function () { try { h.remove(); } catch (e) {} }, 1100);
      }
    } catch (e) {}
  }

  function pagePetPatAnim() {
    if (!pagePet) return;
    try {
      const img = pagePet.els.img;
      // 先摘再挂：连点两次也要第二次照样动（同名 class 已在时 animation 不会重放）
      img.classList.remove('pat');
      void img.offsetWidth;
      img.classList.add('pat');
      setTimeout(function () { try { img.classList.remove('pat'); } catch (e) {} }, 480);
    } catch (e) {}
  }

  function pagePetLevelUp(level) {
    const game = petGameModule();
    if (!game || !pagePet) return;
    try {
      const def = game.LEVELS[level] || game.LEVELS[0];
      pagePet.els.img.classList.add('cheer');
      setTimeout(function () { try { pagePet.els.img.classList.remove('cheer'); } catch (e) {} }, 950);
      pagePetSay('好感度达到「' + def.name + '」！' + (def.line || ''), 3600);
    } catch (e) {}
  }

  function settleStudyIntoBond() {
    const game = petGameModule();
    if (!game || !pagePetBond) return;
    try {
      chrome.storage.local.get('omitoneStudyStats', function (r) {
        try {
          if (chrome.runtime.lastError) return;
          const stats = (r && r.omitoneStudyStats) || {};
          const result = game.applyStudySeconds(pagePetBond, Number(stats.activeSeconds) || 0, game.dayKeyOf(Date.now()));
          if (result.gained > 0) { pagePetBond = result.state; persistPagePetBond(); }
          renderPagePet();
          if (result.leveledUp) pagePetLevelUp(result.level);
        } catch (e) {}
      });
    } catch (e) {}
  }

  function ensurePagePet() {
    const game = petGameModule();
    if (pagePet && pagePet.host && pagePet.host.isConnected) return pagePet;
    if (!game || !document.body) return null;
    try {
      const stale = document.getElementById(PAGE_PET_ID);
      if (stale) stale.remove();

      const host = document.createElement('div');
      host.id = PAGE_PET_ID;
      // 默认锚点是 2026-11-12 在真刷课页量出来的，不是拍的：
      //   状态面板 right:18 宽 280 → 横向 1401~1681、纵向 690~810
      //   学习通自己的右侧竖条 .iconBox → 1629~1669 × 553~806（253px 高，往上挪躲不掉，只能往左让开）
      //   超星机器人 cx-robot-wrapper → 1431~1671 × 668~728
      // 所以横向让开竖条（右边缘 1615 < 竖条左边缘 1629）、纵向压在面板与机器人上方。
      host.style.cssText = ['all:initial', 'position:fixed', 'right:84px', 'bottom:176px',
        'z-index:2147483646', 'pointer-events:none'].join(';');
      const shadow = host.attachShadow({ mode: 'open' });
      if (!shadow) return null;

      shadow.innerHTML = [
        '<style>',
        ':host{all:initial}',
        '*{box-sizing:border-box;margin:0;padding:0}',
        // 整只宠物=一张卡。原先是 5 个零散元素直接坐在页面上（立绘/徽章/进度条/按钮各一块），
        // 叠在学习通自己的右侧条与我们的状态面板上，看着就是"右下角乱七八糟"。
        '.wrap{position:relative;width:158px;pointer-events:auto;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.45;color:#334155;-webkit-user-select:none;user-select:none;touch-action:none}',
        '.card{display:flex;align-items:flex-end;gap:9px;padding:8px 10px 7px;border-radius:16px;background:rgba(255,255,255,.9);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);border:1px solid rgba(15,23,42,.09);box-shadow:0 10px 26px rgba(15,23,42,.16);cursor:grab}',
        '.card.dragging{cursor:grabbing;box-shadow:0 14px 30px rgba(15,23,42,.22)}',
        // 悬停必须有反应 —— 用户原话「交互也基本上不会动」。
        // ⚠️ 只用**不改几何**的属性（边框/阴影）+ 让立绘歪一下头：卡片自己一旦带 transform，
        //   getBoundingClientRect 就和 style.left/top 差几像素，拖动每一拍都按差值漂一次
        //   （"拖着拖着她就跑偏"），而 e2e 那条"位移逐像素跟着手指"也正是断这个。
        '.card.peek{border-color:rgba(244,63,94,.34);box-shadow:0 10px 26px rgba(244,63,94,.19)}',
        '.card.peek .pet{animation:om-pet-peek .52s ease}',
        '@keyframes om-pet-peek{0%{transform:translateY(0) rotate(0)}26%{transform:translateY(-2px) rotate(-6deg)}58%{transform:translateY(0) rotate(4deg)}100%{transform:translateY(0) rotate(0)}}',
        '.pet{display:block;width:52px;height:auto;flex:0 0 auto;cursor:pointer;filter:drop-shadow(0 3px 8px rgba(15,23,42,.22));transform-origin:50% 92%;animation:om-pet-bob 3.4s ease-in-out infinite}',
        '@keyframes om-pet-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
        // 摸头必须有**立刻看得见**的反应 —— 原先只有升级才动一下，用户读成"点了没反应"。
        '.pet.pat{animation:om-pet-pat .44s ease}',
        '@keyframes om-pet-pat{0%{transform:translateY(0) scale(1)}32%{transform:translateY(3px) scale(1.07,.9)}66%{transform:translateY(-2px) scale(.96,1.05)}100%{transform:translateY(0) scale(1)}}',
        '.pet.cheer{animation:om-pet-cheer .9s ease}',
        '@keyframes om-pet-cheer{0%{transform:scale(1)}30%{transform:scale(1.12) rotate(-4deg)}60%{transform:scale(1.06) rotate(3deg)}100%{transform:scale(1)}}',
        '.col{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding-bottom:1px}',
        '.level{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 7px;border-radius:999px;background:#fde68a;color:#92400e;font-size:10px;font-weight:700}',
        '.bond{width:100%;height:4px;border-radius:2px;background:rgba(100,116,139,.25);overflow:hidden}',
        '.bond i{display:block;height:100%;width:0;border-radius:2px;background:linear-gradient(90deg,#ffb6c1,#ff7d9c);transition:width .4s}',
        '.hide{border:0;background:rgba(241,245,249,.9);border-radius:6px;font-size:10px;padding:2px 8px;cursor:pointer;color:#64748b;font-family:inherit}',
        '.hide:hover{background:#e2e8f0;color:#334155}',
        // 气泡：原先 `left:66px` 挂在 92px 宽的 wrap 里 → 可用宽度只剩 26px，
        // `max-width:200px` 只是上限、不会把盒子撑开，于是每行一个字，量到 31×215 的**竖排一大坨**。
        // 现在改到卡片**头顶**、`width:max-content`（不受 wrap 宽度限死），并按屏幕左右半区决定往哪边长。
        '.bubble{position:absolute;bottom:calc(100% - 4px);width:max-content;max-width:min(224px,calc(100vw - 28px));min-width:96px;max-height:104px;overflow:hidden;padding:7px 11px;border-radius:12px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 8px 22px rgba(15,23,42,.16);font-size:12px;line-height:1.5;color:#0f172a;opacity:0;transform:translateY(6px) scale(.96);transition:opacity .18s ease,transform .18s ease;pointer-events:none;word-break:break-word}',
        '.bubble.show{opacity:1;transform:translateY(0) scale(1)}',
        '.bubble::after{content:"";position:absolute;top:calc(100% - 5px);width:9px;height:9px;background:#fff;border-right:1px solid rgba(15,23,42,.1);border-bottom:1px solid rgba(15,23,42,.1);transform:rotate(45deg)}',
        '.bubble.side-right{right:0}.bubble.side-right::after{right:26px}',
        '.bubble.side-left{left:0}.bubble.side-left::after{left:26px}',
        '.heart{position:absolute;width:14px;height:14px;color:#f43f5e;font-size:13px;line-height:14px;pointer-events:none;animation:om-heart-up 1s ease-out forwards}',
        '@keyframes om-heart-up{0%{transform:translateY(0);opacity:1}100%{transform:translateY(-36px);opacity:0}}',
        '.pill{display:none;margin:0 auto;pointer-events:auto;cursor:pointer;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.95);border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;color:#64748b;box-shadow:0 6px 18px rgba(15,23,42,.14);font-family:inherit}',
        '.mode-hidden .card{display:none}',
        '.mode-hidden .bubble{display:none}',
        '.mode-hidden .pill{display:inline-block}',
        '</style>',
        '<div class="wrap" id="wrap">',
        '<div class="card" id="card">',
        '<img class="pet" id="petImg" src="' + chrome.runtime.getURL('popup/pet.png') + '" alt="Omitone" draggable="false">',
        '<div class="col">',
        '<div class="level" id="level">初识</div>',
        '<div class="bond"><i id="bondBar"></i></div>',
        '<button class="hide" id="hideBtn" title="收起来（会留一个小入口，随时点回来）">收</button>',
        '</div>',
        '</div>',
        '<div class="bubble side-right" id="bubble"></div>',
        '<button class="pill" id="pillBtn" title="叫她出来">宠</button>',
        '</div>'
      ].join('');
      document.body.appendChild(host);

      pagePet = {
        host: host,
        els: {
          wrap: shadow.getElementById('wrap'),
          card: shadow.getElementById('card'),
          img: shadow.getElementById('petImg'),
          bubble: shadow.getElementById('bubble'),
          level: shadow.getElementById('level'),
          bondBar: shadow.getElementById('bondBar'),
          hideBtn: shadow.getElementById('hideBtn'),
          pillBtn: shadow.getElementById('pillBtn')
        }
      };
    } catch (e) {
      pagePet = null;
      return null;
    }
    if (!pagePet || !pagePet.els.img) { pagePet = null; return null; }

    // ── 可拖动 ────────────────────────────────────────────────────────────
    // 原先她**完全没有拖动**：位置写死 `right:14px; bottom:120px`，而那个位置正好压住
    // 我们自己的状态面板和学习通的右侧条 —— 用户唯一能表达的"别挡在这儿"就是拖开，
    // 所以这里给整张卡加指针拖动，并把落点存进外观存档（读不到就用默认锚点）。
    let dragState = null;
    let suppressPatUntil = 0;

    function clampPagePetPos(x, y) {
      const w = pagePet.els.wrap.offsetWidth || 158;
      const h = pagePet.els.wrap.offsetHeight || 86;
      const nx = Math.max(8, Math.min(window.innerWidth - w - 8, Math.round(Number(x) || 0)));
      const ny = Math.max(8, Math.min(window.innerHeight - h - 8, Math.round(Number(y) || 0)));
      return { x: nx, y: ny };
    }

    function applyPagePetPos(x, y) {
      const p = clampPagePetPos(x, y);
      // ⚠️ 这里必须走 `pagePet.host` —— 构建块里的 `const host` 只在那个 try 块里存在，
      // 直接写 `host` 是未声明标识符，ReferenceError 会被 handler 自己的 catch 吞掉，
      // 表现就是"拖不动、什么日志都没有"（2026-11-12 实测踩过）。
      const el = pagePet && pagePet.host;
      if (!el) return p;
      // 一旦落到 left/top，就必须把 right/bottom 放开 —— 四个都在时浏览器按 left/top 摆，
      // 但留着它们会让窗口变小时被两边同时拉扯（表现成"卡在一半"）。
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      pagePet.pos = p;
      return p;
    }

    function persistPagePetPos() {
      if (!pagePet || !pagePet.pos) return;
      try {
        const patch = {};
        patch[PAGE_PET_POS_KEY] = pagePet.pos;
        chrome.storage.local.set(patch, function () { void chrome.runtime.lastError; });
      } catch (e) {}
    }

    try {
      const card = pagePet.els.card;
      card.addEventListener('pointerdown', function (ev) {
        try {
          if (ev.button !== 0) return;
          // 按钮上的按下不接管：那是"收起/唤回"，不是搬她
          if (ev.target === pagePet.els.hideBtn || ev.target === pagePet.els.pillBtn) return;
          const r = pagePet.host.getBoundingClientRect();
          dragState = { ox: ev.clientX - r.left, oy: ev.clientY - r.top, sx: ev.clientX, sy: ev.clientY, moved: false, pid: ev.pointerId };
          card.classList.add('dragging');
          // 这里**不许** setPointerCapture ——
          // 一旦在 pointerdown 上捕获，浏览器会把兼容的 mousedown/mouseup/click 一起改派给捕获目标（card），
          // 挂在立绘上的"摸头"监听就再也收不到真鼠标点击：
          // 沙盒里 dispatchEvent 直接打在 img 上，照旧全绿，于是"摸不动"只在现场出现、只在真鼠标下出现。
          // 改成下面 pointermove 越过 6px 阈值再捕获 —— 拖动照样跟手，点击照样归她。
        } catch (e) {}
      });
      card.addEventListener('pointermove', function (ev) {
        try {
          if (!dragState) return;
          // 6px 以内当"点"，不动她 —— 否则每次摸头都会把她挪一两个像素
          if (!dragState.moved && Math.abs(ev.clientX - dragState.sx) + Math.abs(ev.clientY - dragState.sy) < 6) return;
          // 真要搬她了才捕获：此后指针飞出卡片也能继续跟手、pointerup 也一定回到这张卡
          if (!dragState.moved && card.setPointerCapture && dragState.pid != null) {
            try { card.setPointerCapture(dragState.pid); } catch (e) {}
          }
          dragState.moved = true;
          applyPagePetPos(ev.clientX - dragState.ox, ev.clientY - dragState.oy);
        } catch (e) {}
      });
      const endDrag = function (ev) {
        try {
          if (!dragState) return;
          const moved = dragState.moved;
          dragState = null;
          pagePet.els.card.classList.remove('dragging');
          if (moved) {
            // 拖完那一下 pointerup 会跟着派发 click —— 不许她因此被"摸"一次
            suppressPatUntil = Date.now() + 260;
            persistPagePetPos();
            pagePetSay('想把我放哪儿，拽着我就行～', 2000);
          }
        } catch (e) {}
      };
      card.addEventListener('pointerup', endDrag);
      card.addEventListener('pointercancel', function () {
        try { dragState = null; pagePet.els.card.classList.remove('dragging'); } catch (e) {}
      });
      // 悬停反应。走 JS 挂 class 而不是纯 CSS `:hover`：
      // e2e 派发得出 pointerenter，派不出"真·悬停状态"（那要 CDP Input 域），
      // 于是 CSS 写法等于**没测试**——而这条正是用户说"不会动"的两处之一。
      card.addEventListener('pointerenter', function () {
        try { pagePet.els.card.classList.add('peek'); } catch (e) {}
      });
      card.addEventListener('pointerleave', function () {
        try { pagePet.els.card.classList.remove('peek'); } catch (e) {}
      });
      // 窗口变小/切全屏：把她拉回可视范围，别留在屏幕外（进不来就只能重装扩展）
      window.addEventListener('resize', function () {
        try {
          if (pagePet && pagePet.pos) applyPagePetPos(pagePet.pos.x, pagePet.pos.y);
        } catch (e) {}
      });
    } catch (e) {}

    pagePet.els.img.addEventListener('click', function (ev) {
      try {
        if (Date.now() < suppressPatUntil) return;
        pagePetPatAnim();
        const rect = pagePet.els.img.getBoundingClientRect();
        pagePetHearts(ev.clientX || rect.left + rect.width / 2, ev.clientY || rect.top + 8);
        const game = petGameModule();
        if (!game || !pagePetBond) return;
        const result = game.onPat(pagePetBond, game.dayKeyOf(Date.now()));
        pagePetBond = result.state;
        persistPagePetBond();
        renderPagePet();
        if (result.leveledUp) {
          pagePetLevelUp(result.level);
        } else {
          // 摸头也可能正好点亮成就 —— 与弹窗同一套判定（popup/pet.js checkAchievements）
          const fresh = game.evaluateAchievements(pagePetBond, game.dayKeyOf(Date.now()));
          if (fresh.length) {
            const ids = [];
            for (const a of fresh) ids.push(a.id);
            game.markAchievements(pagePetBond, ids, game.dayKeyOf(Date.now()));
            persistPagePetBond();
            pagePetSay('成就点亮「' + fresh[0].name + '」—— ' + (fresh[0].line || ''), 3600);
          } else if (result.line) {
            pagePetSay(result.line, 2400);
          }
        }
        settleStudyIntoBond();
      } catch (e) {}
    });
    pagePet.els.hideBtn.addEventListener('click', function () {
      try {
        pagePet.els.wrap.classList.add('mode-hidden');
        const patch = {};
        patch[PAGE_PET_HIDDEN_KEY] = 1;
        chrome.storage.local.set(patch, function () { void chrome.runtime.lastError; });
      } catch (e) {}
    });
    pagePet.els.pillBtn.addEventListener('click', function () {
      try {
        pagePet.els.wrap.classList.remove('mode-hidden');
        const patch = {};
        patch[PAGE_PET_HIDDEN_KEY] = 0;
        chrome.storage.local.set(patch, function () { void chrome.runtime.lastError; });
      } catch (e) {}
    });

    try {
      chrome.storage.local.get([BOND_STORAGE_KEY, PAGE_PET_HIDDEN_KEY, PAGE_PET_POS_KEY], function (r) {
        try {
          if (chrome.runtime.lastError) return;
          const g = petGameModule();
          if (!g) return;
          const pos = r && r[PAGE_PET_POS_KEY];
          if (pos && typeof pos === 'object' && isFinite(Number(pos.x)) && isFinite(Number(pos.y))) {
            applyPagePetPos(pos.x, pos.y);   // 越界也会被 clamp 拉回屏内
          }
          pagePetBond = g.rollDay(r && r[BOND_STORAGE_KEY], g.dayKeyOf(Date.now()));
          if (r && r[PAGE_PET_HIDDEN_KEY]) pagePet.els.wrap.classList.add('mode-hidden');
          renderPagePet();
          settleStudyIntoBond();
          pagePetSay('一起来刷课吧～点我摸摸头', 3000);
        } catch (e) {}
      });
    } catch (e) {}
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        const g = petGameModule();
        if (changes[BOND_STORAGE_KEY] && changes[BOND_STORAGE_KEY].newValue && g) {
          pagePetBond = g.rollDay(changes[BOND_STORAGE_KEY].newValue, g.dayKeyOf(Date.now()));
          renderPagePet();
        }
        if (changes[PAGE_PET_HIDDEN_KEY] && pagePet && pagePet.els.wrap) {
          if (changes[PAGE_PET_HIDDEN_KEY].newValue) pagePet.els.wrap.classList.add('mode-hidden');
          else pagePet.els.wrap.classList.remove('mode-hidden');
        }
      });
    } catch (e) {}
    // 她偶尔自己开口（"交互不会动"的另一半）。判据全在 pagePetIdleSay 里，这里只管拍子。
    // ⚠️ 先清后建：SPA 换页把她从 DOM 里摘掉再重建时，不清就一个页面挂着好几个 interval，
    //   每个都各自说话 —— 表现正是用户讨厌的"话痨"。
    try {
      // e2e 的把手：主世界派发这个事件 = 手动跑一拍"她该不该说话"，不等 15 秒的定时器。
      // ⚠️ 两件事：① 只能走 DOM 事件 —— 闭包里的函数挂在 `host.__xxx` 上主世界**读不到**
      //   （内容脚本与页面是两个 JS 世界，只有 DOM/属性共用，实测踩过）；
      //   ② 这里必须写 `pagePet.host` —— 构建块里那个 `const host` 早出了作用域，
      //   裸写会把 ReferenceError 交给下面这个 catch 静默吞掉（拖动就那样坏掉过一次）。
      //   不传数据也不回数据：测试读的是气泡本身有没有被点亮。
      pagePet.host.addEventListener('omitone:pet-idle-tick', function () {
        try { pagePetIdleSay(); } catch (e) {}
      });
      // 先清后建：SPA 换页把她从 DOM 里摘掉再重建时，不清就一个页面挂着好几个 interval，
      // 每个都各自说话 —— 表现正是用户讨厌的"话痨"。
      if (pagePetIdleTimer) clearInterval(pagePetIdleTimer);
      pagePetIdleTimer = setInterval(pagePetIdleSay, 15000);
    } catch (e) {}
    return pagePet;
  }

  function handleRuntimeStatus(level, message, meta) {
    if (String(message || '') === 'start') statusPanelActive = true;
    if (!statusPanelActive) return;
    const next = runtimeLogToStatus(level || 'info', message || '', meta || null);
    setStatusPanel(next.state, next.task, next.detail);
  }

  function getDecryptTable() {
    if (!decryptTablePromise) {
      if (Date.now() < decryptTableRetryAt) return Promise.resolve(null);
      decryptTablePromise = loadDecryptTable().catch(() => null).then((table) => {
        if (table) {
          decryptTableFailures = 0;
          decryptTableRetryAt = 0;
        } else {
          // 失败只在短暂冷却期内复用；新一轮扫描可以重试，不缓存 null 到页面关闭。
          decryptTableFailures = Math.min(decryptTableFailures + 1, 5);
          decryptTableRetryAt = Date.now() + Math.min(5000 * Math.pow(2, decryptTableFailures - 1), 60000);
          decryptTablePromise = null;
        }
        return table;
      });
    }
    return decryptTablePromise;
  }

  function fetchDecryptResource(resource, binary) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('font table resource timeout'));
      }, contentScaledMs(DECRYPT_FETCH_TIMEOUT_MS));
    });
    // 一个期限覆盖响应头和响应体；即使底层忽略 AbortSignal，外层也会结束。
    const work = Promise.resolve().then(() => fetch(chrome.runtime.getURL(resource), { signal: controller.signal }))
      .then((response) => {
        if (!response.ok) throw new Error('font table resource unavailable');
        return binary ? response.arrayBuffer() : response.json();
      });
    return Promise.race([work, timeout]).finally(() => {
      clearTimeout(timer);
      controller.abort();
    });
  }

  /**
   * 加载字形映射表。
   *
   * 优先紧凑二进制 `resources/table.bin`（122KB，不需要解析 JSON，内存占用也小一个量级）；
   * 退化到明文 `resources/table.json`（347KB）—— 源码目录在没跑过 `npm run build` 时
   * 没有 .bin，这条退路保证"直接加载仓库根目录"仍然能用，只是慢一些、占得多一些。
   */
  async function loadDecryptTable() {
    if (!FONT_TABLE) {
      console.error('[Omitone] libs/font-table.js 未加载');
      return null;
    }
    try {
      const bytes = await fetchDecryptResource('resources/table.bin', true);
      const table = FONT_TABLE.decode(bytes);
      if (table) return table;
      console.warn('[Omitone] table.bin 格式非法，回退到 table.json');
    } catch (e) {}

    try {
      const data = await fetchDecryptResource('resources/table.json', false);
      const table = FONT_TABLE.fromObject(data);
      if (!table || !table.size) return null;
      console.warn('[Omitone] 正在使用明文 table.json（347KB）—— 跑一次 npm run build 可生成 122KB 的 table.bin');
      return table;
    } catch (e2) {
      console.error('[Omitone] failed to load decrypt table', e2);
      return null;
    }
  }

  function decodeBase64ToUint8Array(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function extractSecretFontBase64(doc) {
    try {
      const styles = Array.from(doc.querySelectorAll('style'));
      for (const style of styles) {
        const text = String(style.textContent || '');
        if (text.indexOf('font-cxsecret') === -1) continue;
        const match = text.match(/base64,([A-Za-z0-9+/=]+)['")]/);
        if (match) return match[1];
      }
    } catch (e) {}
    return '';
  }

  function buildTyprFont(bytes) {
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const fonts = Typr.parse(buffer);
      return fonts && fonts[0] ? fonts[0] : null;
    } catch (e) {
      console.error('[Omitone] failed to parse secret font', e);
      return null;
    }
  }

  function collectUniqueSecretChars(elements) {
    const chars = new Set();
    const collect = (value) => {
      const text = String(value || '');
      for (const char of text) {
        if (!char.trim()) continue;
        if (char.codePointAt(0) <= 127) continue;
        chars.add(char);
      }
    };

    elements.forEach((el) => {
      collect(el.textContent || '');
      ['aria-label', 'title', 'value', 'placeholder'].forEach((attr) => {
        if (el.hasAttribute && el.hasAttribute(attr)) collect(el.getAttribute(attr));
      });
    });

    return Array.from(chars);
  }

  function buildDecryptMapForDoc(doc, base64, table, elements) {
    // 缺表/依赖/解析失败都是可恢复状态，不能把空结果当成成功缓存。
    // 返回 { map, missed, computed }：missed/computed 给上层判断「映射表是否落后于平台字形」
    // —— 那是唯一会表现成"题干全是乱码"的失败，不报错就必须在这里留痕。
    if (!table || typeof md5 !== 'function') return { map: new Map(), missed: 0, computed: 0 };
    let cached = decryptMapCache.get(base64);
    if (!cached || cached.table !== table) {
      const font = buildTyprFont(decodeBase64ToUint8Array(base64));
      if (!font) return { map: new Map(), missed: 0, computed: 0 };
      cached = { font, table, map: new Map(), checked: new Set() };
    }
    // 同字体可能在后续题目/文档中出现新字符，命中字体不等于字符映射齐全。
    const { font, map, checked } = cached;
    decryptMapCache.delete(base64);
    decryptMapCache.set(base64, cached);
    while (decryptMapCache.size > MAX_DECRYPT_FONTS) decryptMapCache.delete(decryptMapCache.keys().next().value);

    let computed = 0;
    let missed = 0;
    const chars = collectUniqueSecretChars(elements);
    chars.forEach((char) => {
      if (checked.has(char)) return;
      try {
        const glyph = Typr.U.codeToGlyph(font, char.codePointAt(0));
        if (!glyph) { checked.add(char); return; }
        computed++;
        const path = Typr.U.glyphToPath(font, glyph);
        const hash = md5(JSON.stringify(path)).slice(24);
        const decoded = table.get(hash);
        if (decoded) map.set(char, decoded);
        else missed++;
        checked.add(char);
      } catch (e) {}
    });

    return { map, missed, computed };
  }

  function decodeStringByMap(value, map) {
    let output = String(value || '');
    map.forEach((decoded, encoded) => {
      output = output.split(encoded).join(decoded);
    });
    return output;
  }

  function getOutermostSecretRoots(doc) {
    const all = Array.from(doc.querySelectorAll('.font-cxsecret'));
    return all.filter((node) => !node.parentElement || !node.parentElement.closest('.font-cxsecret'));
  }

  function decryptRootElement(root, map) {
    const doc = root.ownerDocument;
    const elementList = [root, ...Array.from(root.querySelectorAll('*'))];
    elementList.forEach((el) => {
      ['aria-label', 'title', 'value', 'placeholder'].forEach((attr) => {
        if (el.hasAttribute && el.hasAttribute(attr)) {
          el.setAttribute(attr, decodeStringByMap(el.getAttribute(attr), map));
        }
      });
      if (el.classList) el.classList.remove('font-cxsecret');
    });

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    textNodes.forEach((textNode) => {
      textNode.nodeValue = decodeStringByMap(textNode.nodeValue, map);
    });
  }

  // 结论的说明直接落进日志：用户只会说"题干是乱码"，这一句 hint 才是根因。
  // nodecl / nomap 是**终局**判据（再扫一百次也不会变），page.js 据此不再白等 8 秒。
  const FONT_STATE_HINT = {
    clean: '这份文档没有 font-cxsecret 残留，不需要解密',
    plain: '类名是残留、文字其实是明文（已批改的结果页常见）—— 已摘掉类名',
    nodecl: '有密文但文档里找不到字体声明（@font-face 的 base64）—— 这一份解不了，再等也不会成',
    nomap: '拿到了字体但映射表建不起来（表没加载 / 字体解析失败 / 字形全部未命中）—— 再等也不会成，需要更新 resources/table',
    partial: '已解密，但部分字形在映射表里查不到 —— 那几个字会解成错字，需要更新 resources/table',
    done: '字形全部命中，已解密完成'
  };

  function setFontDocAttr(doc, name, value) {
    try {
      const el = doc.documentElement || doc.body;
      if (!el || !el.setAttribute) return;
      // 值没变就不写：扫描每秒都在跑，制造无意义的 DOM 变动会把防抖拖回饿死的老路
      if (el.getAttribute(name) === value) return;
      el.setAttribute(name, value);
    } catch (e) {}
  }

  function reportFontVerdict(doc, state, detail) {
    setFontDocAttr(doc, FONT_STATE_ATTR, state);
    setFontDocAttr(doc, FONT_SWEEP_ATTR, String(Date.now()));
    if (state === 'clean' || state === 'done') return;
    const nowMs = Date.now();
    const last = fontVerdictLog.get(doc);
    if (last && last.state === state && nowMs - last.at < 60000) {
      last.suppressed = (last.suppressed || 0) + 1;
      return;
    }
    const suppressed = last && last.state === state ? (last.suppressed || 0) : 0;
    fontVerdictLog.set(doc, { state, at: nowMs, suppressed: 0 });
    appendRuntimeLog('warn', 'font decrypt verdict', Object.assign({
      state: state,
      suppressed: suppressed,
      hint: FONT_STATE_HINT[state] || ''
    }, detail || {}));
  }

  async function decryptSecretFontsInDocument(doc) {
    if (!doc || !doc.querySelectorAll) return;
    let roots = [];
    try { roots = getOutermostSecretRoots(doc); } catch (e) { return; }
    if (!roots.length) {
      // 没有残留 = 没有待办。这里**不**打日志（每份文档每一轮都会走到，是纯噪音），
      // 但仍然盖扫描时间戳：page.js 靠"时间戳新不新"区分「扫过了，确实没有」和
      // 「扫描根本没跑到这一份文档」—— 后者才是"连解码都没有"的那一种。
      reportFontVerdict(doc, 'clean', null);
      return;
    }

    const base64 = extractSecretFontBase64(doc);
    if (!base64) {
      // 真实平台行为（其他开源实现同样处理）：已批改的**结果页**会给明文题干挂着
      // font-cxsecret 类，却不再提供字体声明 —— 类名是残留，不是加密。
      // 此时若等它解密，page.js 的第一层守卫会每轮白等 8 秒。
      // 判据保守：文本里连一个 PUA 密文字符都没有，才视为明文并摘掉类名。
      let hasCipherText = false;
      roots.forEach(function (root) {
        if (/[\uE000-\uF8FF]/.test(root.textContent || '')) hasCipherText = true;
      });
      if (!hasCipherText) {
        roots.forEach(function (root) { if (root.classList) root.classList.remove('font-cxsecret'); });
        reportFontVerdict(doc, 'plain', { roots: roots.length });
        return;
      }
      // 到这里就是以前那条「什么都不做也不吭声」的分支：文档里根本没有字体声明，
      // 解不了，而且**永远不会**变好。它让 page.js 每份卷子白等 8 秒（实测 2026-11-10
      // 两份卷子各等 8.1s / 12.2s，日志里解密层一条记录都没有）。
      reportFontVerdict(doc, 'nodecl', { roots: roots.length, cipher: true });
      return;
    }

    const table = await getDecryptTable();
    const built = buildDecryptMapForDoc(doc, base64, table, roots);
    const decodeMap = built.map;

    const nowMs = Date.now();
    const mayLogMiss = nowMs - lastFontMissLogAt > 60000;

    if (!decodeMap.size) {
      // 一个字形都没命中：多半是映射表快照落后于平台的字符集。这个状态的表现是
      // "题干全是乱码"（README 已知缺陷 #6），页面照常渲染、不抛异常 —— 不在这里留痕，
      // 用户和维护者都不可能知道根因是表过期。
      if (built.computed > 0 && built.missed > 0 && mayLogMiss) {
        lastFontMissLogAt = nowMs;
        appendRuntimeLog('warn', 'font decrypt miss', {
          missed: built.missed, computed: built.computed,
          hint: '字形哈希在映射表里全部未命中 —— resources/table.json 需要更新'
        });
      }
      // ⚠️ 这里以前是**整块静默**：table 没加载（computed=0）时连上面那条 warn 都不发。
      // reason 分开报：no-table 是"表没到手"，no-glyph 是"字全是空缺"，all-miss 是"表落后"。
      reportFontVerdict(doc, 'nomap', {
        roots: roots.length,
        reason: !table ? (FONT_TABLE ? 'table-load-failed' : 'table-module-missing')
          : (built.computed > 0 ? 'all-glyph-miss' : 'no-glyph-in-font'),
        missed: built.missed,
        computed: built.computed
      });
      return;
    }

    roots.forEach((root) => decryptRootElement(root, decodeMap));
    let partial = built.missed > 0;
    try {
      // ⚠️ font-cxsecret 的真实机制是「正常中文字符 + 自定义字形」，不是 PUA 私有区：
      //    表缺字形时文本是**通顺但错误**的中文，人眼和 PUA 检测都发现不了。
      //    所以文档级的 miss 标记才是 page.js 乱码守卫的可靠信号源。
      if (partial) {
        doc.documentElement.setAttribute('data-om-font-miss', String(built.missed));
        if (mayLogMiss) {
          lastFontMissLogAt = nowMs;
          appendRuntimeLog('warn', 'font decrypt incomplete', {
            missed: built.missed, mapped: decodeMap.size,
            hint: '部分字形哈希未命中映射表，对应文字解出来是错字 —— resources/table.json 需要更新'
          });
        }
      } else if (doc.documentElement.getAttribute('data-om-font-miss')) {
        doc.documentElement.removeAttribute('data-om-font-miss');
      }
    } catch (e) { /* 标记失败不影响解密本身 */ }
    // 结论落在 try 外面：标记写失败是小事，page.js 读不到「这一份已经解过」才是大事
    reportFontVerdict(doc, partial ? 'partial' : 'done', {
      roots: roots.length, missed: built.missed, mapped: decodeMap.size
    });
    console.log('[Omitone] font decrypted roots:', roots.length, 'mapped chars:', decodeMap.size);
  }

  function walkSameOriginDocuments(doc, visitor, depth = 0) {
    if (!doc || depth > 4) return;
    visitor(doc);
    let frames = [];
    try {
      frames = doc.querySelectorAll('iframe');
    } catch (e) {}
    frames.forEach((frame) => {
      try {
        const subDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        walkSameOriginDocuments(subDoc, visitor, depth + 1);
      } catch (e2) {}
    });
  }

  async function runFontDecryptSweep() {
    if (decryptSweepRunning) {
      // 上一轮还没结束（refreshPageScope 要问后台，最长 5 秒；解密本身也要等表）。
      // 不并发全页重扫，排到下一轮即可 —— 有界防抖保证这一轮等不出"8 秒黑洞"。
      scheduleDecryptSweep();
      return;
    }
    decryptSweepRunning = true;
    try {
      if (await refreshPageScope() !== 'study') return;
      const jobs = [];
      walkSameOriginDocuments(document, (doc) => {
        if (!observedDocs.has(doc)) {
          observedDocs.add(doc);
          try {
            const observer = new MutationObserver(() => scheduleDecryptSweep());
            observer.observe(doc.documentElement || doc.body || doc, { childList: true, subtree: true, characterData: true });
          } catch (e) {}
        }
        jobs.push(decryptSecretFontsInDocument(doc));
      });
      await Promise.all(jobs);
    } finally {
      decryptSweepRunning = false;
    }
  }

  async function loadConfig() {
    const scope = await refreshPageScope();
    if (scope === 'none') return {};
    const response = await sendRuntimeMessageWithTimeout({ type: 'get_config' }, 5000, 'config read timeout');
    if (!response || !response.success || !response.config || !scopeIsCurrent(scope)) return {};
    if (scope === 'study') {
      // Raw provider config stays in the isolated world; fingerprint the saved snapshot,
      // not defaults or a newly reloaded config obtained after the request finishes.
      const loaded = { ...response.config };
      const fingerprint = POLICY.configFingerprint(loaded);
      delete loaded.forceLearn;
      configs = { ...CONFIG_DEFAULTS, ...loaded };
      const snapshot = { ...configs };
      requestFingerprints.set(snapshot, fingerprint);
      return snapshot;
    }
    // External captcha tabs ask the worker for an already-redacted projection.
    configs = POLICY.publicConfig(response.config, 'captcha');
    return { ...configs };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.config) return;
    // Do not copy raw changes.config into an external page's retained configuration.
    loadConfig().then((config) => {
      if (!scopeIsCurrent()) return;
      window.postMessage({ source: 'xxt_bridge', type: 'XXT_CONFIG_UPDATED', data: publicConfig(config) }, '*');
    }).catch(() => {});
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'xxt_app') return;
    const scope = await refreshPageScope();
    const captchaTypes = ['get_config', 'llm_captcha', 'fetch_image', 'runtime_log'];
    if (scope === 'none' || (scope === 'captcha' && !captchaTypes.includes(msg.type))) {
      window.postMessage({ source: 'xxt_bridge', id: msg.id,
        type: msg.type === 'get_config' ? 'config_response' : 'llm_response',
        data: { success: false, error: 'scope_denied', scope } }, '*');
      return;
    }

    if (msg.type === 'get_config') {
      const config = await loadConfig();
      window.postMessage({
        source: 'xxt_bridge',
        id: msg.id,
        type: 'config_response',
        data: publicConfig(config)
      }, '*');
      return;
    }

    if (msg.type === 'llm_request') {
      // 必须带 .catch 回传失败：page.js 的 bridgeSend 已有超时兜底，但正常路径下
      // 任何未捕获异常都会导致不回消息、主循环挂起 90 秒
      handleLLMRequestDirect(msg.payload).then((response) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: response
        }, '*');
      }).catch((err) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: 'llm_request internal error: ' + (err && err.message ? err.message : String(err)) }
        }, '*');
      });
      return;
    }

    if (msg.type === 'llm_vision') {
      handleVisionRequestDirect(msg.payload).then((response) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: response
        }, '*');
      }).catch((err) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: 'llm_vision internal error: ' + (err && err.message ? err.message : String(err)) }
        }, '*');
      });
      return;
    }

    if (msg.type === 'llm_captcha') {
      handleCaptchaRequestDirect(msg.payload).then((response) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: response
        }, '*');
      }).catch((err) => {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: 'llm_captcha internal error: ' + (err && err.message ? err.message : String(err)) }
        }, '*');
      });
      return;
    }

    if (msg.type === 'fetch_image') {
      // 跨域验证码图片：交由后台带 Cookie 抓取，避免画布污染
      try {
        chrome.runtime.sendMessage(
          { type: 'fetch_image_dataurl', payload: msg.payload || {} },
          (response) => {
            const lastError = chrome.runtime.lastError;
            window.postMessage({
              source: 'xxt_bridge',
              id: msg.id,
              type: 'llm_response',
              data: lastError
                ? { success: false, error: lastError.message || String(lastError) }
                : (response || { success: false, error: 'background no response' })
            }, '*');
          }
        );
      } catch (err) {
        window.postMessage({
          source: 'xxt_bridge',
          id: msg.id,
          type: 'llm_response',
          data: { success: false, error: err && err.message ? err.message : String(err) }
        }, '*');
      }
      return;
    }

    if (msg.type === 'storage_set') {
      const payload = msg.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, 'xxtRunning') ||
          typeof payload.xxtRunning !== 'boolean') {
        window.postMessage({ source: 'xxt_bridge', id: msg.id, type: 'llm_response', data: { success: false, error: 'invalid_storage_patch' } }, '*');
        return;
      }
      const response = await sendRuntimeMessageWithTimeout({ type: 'storage_set', payload: { xxtRunning: payload.xxtRunning } }, 5000);
      window.postMessage({ source: 'xxt_bridge', id: msg.id, type: 'llm_response', data: response }, '*');
      return;
    }

    if (msg.type === 'runtime_log') {
      pageRuntimeActivityAt = Date.now();
      appendRuntimeLog(msg.level || 'info', msg.message || '', msg.meta || null);
      handleRuntimeStatus(msg.level || 'info', msg.message || '', msg.meta || null);
      recordStudyActivity();
    }
  });

  function getPageScriptUrl() {
    return chrome.runtime.getURL('page.js');
  }

  function removeInjectedScript() {
    const oldScript = document.getElementById(PAGE_SCRIPT_ID);
    if (oldScript) oldScript.remove();
  }

  function hasPageRuntimeEvidence() {
    if (document.getElementById('xxt-panel')) return true;
    if (!pageRuntimeActivityAt) return false;
    // ① 这次注入之后**有过任意一条运行日志** —— 就说明 page.js 活着。
    // ⚠️ 不能要求「最近 4 秒内」：空闲时 `_ensureOcsStudyRunner` 的循环
    // 每 60 秒才写一条日志，4 秒窗口必然过期 → 误报「运行脚本未响应」，
    // 用户看到红色错误就把插件当坏了、反复刷新（实测 11:58:41 有日志，
    // 11:58:47 报错，中间什么都没发生）。
    if (pageRuntimeActivityAt >= pageRuntimeArmedAt) return true;
    // ② 本次是**重复注入**（页面里本来就跑着一份 page.js）：它最近两分钟说过话
    // 就算活着。只给重复注入这个宽限，首次注入仍要求"注入后确实有日志"，
    // 否则"脚本根本没跑起来"会被上一份的旧时间戳一直盖住。
    return Date.now() - pageRuntimeActivityAt < 120000;
  }

  /**
   * 这条看门狗**只在自己还握着这一页时**才有权报错（批次 10-B）。
   *
   * 为什么要这一道：真实日志 00:45:35 page.js 已经打出 `start` + `performance profile`
   * （= 它活着、而且在答题），00:45:38 却冒出一条红色 `page script no response after tag
   * injection {reason:"startup", waitedMs:10000}` —— 用户看到的就是「插件坏了，去刷新」，
   * 而刷新恰恰把那 10 秒的真实进度全丢掉。日志流是**跨文档共享**的（刷新/软导航后新旧两份
   * content.js 都往同一个 200 条缓冲里写），所以"这一份实例没见过日志"根本推不出
   * "这一页没有 page.js 在跑"。
   *
   * 三个条件都必须成立才继续判：本次注入仍是最新一次（`seq`）、**这份文档还挂在浏览器上**
   * （导航后的旧文档 `isConnected` 为 false）、注入用的 `<script>` 还在原地
   * （被移走 = 这一份注入已经作废，`removeInjectedScript` 只在新注入时调用）。
   */
  function watchdogStillOwnsPage(seq) {
    if (seq !== pageInjectSeq) return false;
    if (!document.isConnected) return false;
    const tag = document.getElementById(PAGE_SCRIPT_ID);
    return !!(tag && tag.isConnected);
  }

  function scheduleInjectionWatchdog(seq, reason) {
    // ⚠️ 原来只等 1.8 秒就报「运行脚本未响应」，在弱 CPU 上会误报：
    // page.js 有 558KB，解析 + 初始化在轻薄本上跑 2~3 秒很常见。
    // 现在改成两段：6 秒先看一眼，仍无任何运行痕迹再等 4~6 秒才报错。
    // 真的挂起只是晚几秒提示，误报却会让用户以为插件坏了去反复刷新。
    setTimeout(() => {
      if (!watchdogStillOwnsPage(seq)) return;
      if (hasPageRuntimeEvidence()) return;

      setTimeout(() => {
        if (!watchdogStillOwnsPage(seq)) return;
        if (hasPageRuntimeEvidence()) return;

        appendRuntimeLog('error', 'page script no response after tag injection', {
          reason: reason || '',
          // ⚠️ `waitedMs` 以前是**两个常数相加**写出来的 10000 —— 日志里看着像测量值，
          // 实际一次都没量过。现在报真实等待，并给出判据的三个输入，
          // 下一份日志能直接分辨「真没起来」与「这一份实例不该说话」。
          waitedMs: Math.max(0, Date.now() - pageRuntimeArmedAt),
          slowFactor: contentSlowFactor(),
          everSawLog: pageRuntimeActivityAt > 0,
          lastLogAgoMs: pageRuntimeActivityAt ? Date.now() - pageRuntimeActivityAt : -1,
          docConnected: document.isConnected === true,
          href: String(location.href || '').slice(0, 90)
        });
        if (statusPanelActive) {
          setStatusPanel('error', '运行脚本未响应', '未检测到初始弹窗或启动日志，请刷新学习通页面后重试');
        }
      }, Math.max(4000, contentScaledMs(2000)));
    }, Math.max(6000, contentScaledMs(1800)));
  }

  function injectPageScript(reason = 'default') {
    if (!scopeIsCurrent()) return;
    removeInjectedScript();
    // 不清 `pageRuntimeActivityAt`：重复注入时页面里那份还在跑，清掉等于假装它没说过话
    // （见 hasPageRuntimeEvidence 的第 ② 条）。改为记下"本次从哪一刻开始算证据"。
    pageRuntimeArmedAt = Date.now();
    const seq = ++pageInjectSeq;

    const scriptUrl = getPageScriptUrl();
    const script = document.createElement('script');
    script.id = PAGE_SCRIPT_ID;
    script.src = scriptUrl;
    script.onload = () => {
      console.log('%c[Omitone] page runtime injected', 'color:#4CAF50');
    };
    script.onerror = () => {
      console.error('%c[Omitone] failed to inject page runtime', 'color:#F44336');
      appendRuntimeLog('warn', 'page script tag injection failed', { reason });
    };

    (document.head || document.documentElement).appendChild(script);
    scheduleInjectionWatchdog(seq, reason);
  }

  function scheduleDecryptSweep() {
    if (!scopeIsCurrent('study')) return;
    const nowMs = Date.now();
    if (!decryptSweepPendingSince) decryptSweepPendingSince = nowMs;
    if (decryptSweepTimer) clearTimeout(decryptSweepTimer);
    // 尾部防抖 + 两个上限，缺一不可（2026-11-10 批次 5）：
    //   · 等满 2 秒必跑 —— 纯 300ms 尾部防抖会被**页面自己的 DOM 写入**无限续期
    //     （填答、审计、状态标记，OCS 循环每秒一轮），扫描永远排不到，
    //     用户看到的「连解码都没有」就是这么来的。
    //   · 两次扫描至少隔 400ms —— 只有前一条会把扫描变成每 0ms 一次全页重扫，白烧 CPU。
    const waited = nowMs - decryptSweepPendingSince;
    let delay = Math.max(DECRYPT_SWEEP_DEBOUNCE_MS - waited, 0);
    const gapLeft = DECRYPT_SWEEP_MIN_GAP_MS - (nowMs - decryptSweepLastAt);
    if (gapLeft > delay) delay = gapLeft;
    decryptSweepTimer = setTimeout(() => {
      decryptSweepTimer = null;
      decryptSweepPendingSince = 0;
      decryptSweepLastAt = Date.now();
      runFontDecryptSweep().catch((err) => {
        console.error('[Omitone] decrypt sweep failed', err);
      });
    }, delay);
  }

  async function maybeMarkAutoResume() {
    // 运行标记：验证码刷新/页面跳转后自动恢复运行
    try {
      await new Promise((resolve) => {
        chrome.storage.local.get('xxtRunning', (result) => {
          const lastError = chrome.runtime.lastError;
          if (!lastError && result && result.xxtRunning) {
            document.documentElement.setAttribute(AUTO_START_ATTR, '1');
            appendRuntimeLog('info', 'auto resume after reload', {});
          }
          resolve();
        });
      });
    } catch (e) {}
  }

  async function start() {
    // ⚠️ 这里必须是带重试的那一问（原因见 `refreshPageScopeWithRetry` 头上）。
    // 页面**刚加载**那一刻也是竞态窗口：SW 可能才醒、标签页纪元还没落定，
    // 旧代码问一次拿到 'none' 就 `return`，之后没有任何人会再问 ——
    // 表现和"扩展没装"一模一样，而重载扩展 + F5 才好，正是这个原因。
    const scope = await refreshPageScopeWithRetry();
    if (scope === 'none') return;
    await loadConfig();
    if (!scopeIsCurrent(scope)) return;
    if (scope === 'captcha') {
      document.documentElement.setAttribute(AUTO_START_ATTR, '1');
      injectPageScript('authorized-captcha');
      return;
    }
    await maybeMarkAutoResume();
    scheduleDecryptSweep();
    injectPageScript('startup');
    ensurePagePet();
  }

  function startSafely() {
    start().catch((error) => appendRuntimeLog('error', 'content startup failed', { error: String(error && error.message || error) }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startSafely);
  } else {
    startSafely();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'xxt_start') {
      // 手动启动走有界重试：弹窗侧的超时是 10 秒，四次问完最多 5.5 秒，仍在之内。
      refreshPageScopeWithRetry().then((scope) => {
        if (scope === 'none') {
          sendResponse({ success: false, error: 'scope_denied', scope: 'none' });
          return;
        }
        // Ack means accepted, not page-runtime ready. Startup runs separately with a catch.
        sendResponse({ success: true, accepted: true, scope });
        document.documentElement.setAttribute(AUTO_START_ATTR, '1');
        if (scope === 'study') {
          sendRuntimeMessageWithTimeout({ type: 'storage_set', payload: { xxtRunning: true } }, 5000);
          showStatusPanel('wait', '启动中', '正在注入运行脚本');
        }
        loadConfig().then(() => {
          if (!scopeIsCurrent(scope)) return;
          scheduleDecryptSweep();
          injectPageScript('manual-start');
        }).catch((error) => appendRuntimeLog('error', 'manual start failed', { error: String(error && error.message || error) }));
      }).catch(() => sendResponse({ success: false, error: 'scope_denied', scope: 'none' }));
      return true;
    }
    return false;
  });

  let lastPageUrl = location.href;
  let urlRetryTimer = null;
  let urlRetryRound = 0;
  const URL_RETRY_MAX_ROUNDS = 3;
  const URL_RETRY_STEP_MS = 5000;

  /**
   * 只清**扩展侧**的旧状态，不动 `page.js` 的 script 标签。
   * 标签由下一次 `injectPageScript` 自己换走；在这里提前摘掉等于把还在跑的那份判死
   * （page.js 靠"自己的标签还在不在"自认作废 —— 批次 18 的病根就是这个）。
   */
  function resetBridgeState() {
    pageScope = 'none';
    scopeUrl = '';
    configs = {};
    if (decryptSweepTimer) clearTimeout(decryptSweepTimer);
    decryptSweepTimer = null;
    decryptSweepPendingSince = 0;
  }

  /** 彻底下线：扩展侧清空 **并且** 摘掉标签（只有确定这一页不该再跑学习时才用） */
  function dropPageRuntime() {
    resetBridgeState();
    removeInjectedScript();
  }

  /**
   * ⚠️ 顺序是「先问权威，再拆台」，旧代码正好反了。
   *
   * 为什么必须反过来（2026-11-11 真页面实测）：学习通切章节走 `pushState`，同一个文档、
   * 不换 JS 上下文。旧 `onPageChanged` 一进来就抹掉 `pageScope` + `removeInjectedScript()`，
   * 然后**只问一次**权限；那一次恰好撞上 SW 侧 `tabs.onUpdated` → `revokeTab` 的纪元跳格，
   * 回 `'none'` → `start()` 直接 return。于是台拆了、重建又失败：
   * 页面里那份 page.js 被自己的缺失标签判死，桥从此每条消息 `scope_denied`（1~2ms 拒绝，
   * 一条日志都进不了存储），用户看到的只有「又不答题了」「卡住了」，唯一解法是手动 F5。
   *
   * 现在：问到才拆旧的重建新的；问不到而这一页**是学习通**，就保持现状继续跑、
   * 亮一句"正在重连扩展"，并有界重试几轮；问不到且不是学习通才真下线。
   */
  async function restartForCurrentUrl(reason) {
    const askedUrl = location.href;
    const scope = await refreshPageScopeWithRetry();
    // 问的过程中又换页了：这一轮作废，最新那次 `onPageChanged` 会自己接管
    if (location.href !== askedUrl) return;
    if (scope !== 'none') {
      urlRetryRound = 0;
      if (urlRetryTimer) {
        clearTimeout(urlRetryTimer);
        urlRetryTimer = null;
      }
      resetBridgeState();
      startSafely();
      return;
    }
    if (POLICY && POLICY.isChaoxingUrl(location.href)) {
      appendRuntimeLog('warn', 'scope not granted after page change', {
        reason: reason || '',
        round: urlRetryRound + 1,
        href: String(location.href || '').slice(0, 90)
      });
      if (urlRetryRound < URL_RETRY_MAX_ROUNDS) {
        urlRetryRound++;
        showStatusPanel('wait', '正在重连扩展', '切换章节后没问到权限，稍后自动重试；一直不动请按 F5');
        if (urlRetryTimer) clearTimeout(urlRetryTimer);
        urlRetryTimer = setTimeout(() => {
          urlRetryTimer = null;
          restartForCurrentUrl((reason || 'page-change') + '-retry').catch(() => {});
        }, URL_RETRY_STEP_MS);
        return;
      }
      // 四整轮都没问到：别再挂着一个已经不可信的运行时，但**先把话说明白**再下线，
      // 否则日志里就只剩"什么都没有"，下一次排查还是只能靠猜。
      appendRuntimeLog('error', 'scope lost, bridge stopped', {
        reason: reason || '',
        rounds: URL_RETRY_MAX_ROUNDS,
        href: String(location.href || '').slice(0, 90)
      });
      showStatusPanel('error', '扩展通道断开', '多次询问权限都没通过，请按 F5 刷新学习通页面');
    }
    dropPageRuntime();
  }

  function onPageChanged() {
    if (location.href === lastPageUrl) return;
    lastPageUrl = location.href;
    if (urlRetryTimer) {
      clearTimeout(urlRetryTimer);
      urlRetryTimer = null;
    }
    urlRetryRound = 0;
    restartForCurrentUrl('page-change').catch((error) => {
      appendRuntimeLog('error', 'page change restart failed', { error: String(error && error.message || error) });
    });
  }

  const rawPushState = history.pushState;
  history.pushState = function () {
    rawPushState.apply(this, arguments);
    setTimeout(onPageChanged, 500);
  };

  const rawReplaceState = history.replaceState;
  history.replaceState = function () {
    rawReplaceState.apply(this, arguments);
    setTimeout(onPageChanged, 500);
  };

  window.addEventListener('popstate', () => setTimeout(onPageChanged, 500));
  window.addEventListener('hashchange', () => setTimeout(onPageChanged, 500));
  document.addEventListener('readystatechange', scheduleDecryptSweep);
  window.addEventListener('load', scheduleDecryptSweep);

  console.log('%c[Omitone] content bridge ready', 'color:#2196F3');
  // ⚠️ 必须带上**构建戳**。本轮排查连着踩了同一个坑：四个包都叫 1.2.8，
  // 用户发来的日志里看不出跑的是哪一版 —— 时间戳一对才发现"这份日志比修复还早"，
  // 白排查了一轮（2026-10-17）。`version_name` 由 `tools/build.js` 在**产物**里写入
  //（源码的 manifest 不动），所以从 dist 装出去的包都能自报家门。
  var manifestInfo = null;
  try { manifestInfo = chrome.runtime.getManifest(); } catch (eManifest) { manifestInfo = null; }
  appendRuntimeLog('info', 'content bridge ready', {
    version: String((manifestInfo && manifestInfo.version) || ''),
    build: String((manifestInfo && manifestInfo.version_name) || '(源码目录，未经 build)'),
    // ⚠️ content.js 这一侧的"带哪些修复"标记，与 page.js 那个 `start` 里的 build 同一用途：
    // **日志里缺哪个 = 那份改动还没被加载**。批次 17 就是被这一格坑的：磁盘上已经修好，
    // 页面跑的还是旧 content.js，两边都以为生效了，用户看到的是「还是卡住的」。
    // page.js 有 `code` 内容指纹兜底，而 content.js 不在 concat 的范围里、没有指纹，
    // 所以这一栏是 content.js 侧唯一的自证 —— 加改动就加标记，别让它空着。
    marks: ['refill-per-question', 'scope-retry']
  });
})();
