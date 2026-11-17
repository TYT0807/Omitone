/** Classic MV3 worker. Privileged operations are authorized from browser-owned sender/tab state. */
importScripts('libs/api-url.js', 'libs/prompt.js', 'libs/thinking.js', 'libs/runtime-policy.js', 'libs/captcha.js', 'runtime-log-store.js');
(function () {
  'use strict';
  var policy = self.OmitonePolicy;
  var startedAt = Date.now();
  var configQueue = Promise.resolve();
  var grantQueue = Promise.resolve();
  var RUNTIME_LOGS_KEY = 'runtimeLogs';
  var tabEpochs = Object.create(null);
  var GRANT_MS = 10 * 60 * 1000;
  var IMAGE_LIMIT = 2 * 1024 * 1024;
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'];

  function failure(code, error) { return { success: false, code: code, error: error || code }; }
  function errorText(error) { return error && error.message ? String(error.message) : String(error || 'request failed'); }
  function chromeCall(target, method, args) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { finish(new Error('browser operation timeout')); }, 5000);
      function finish(error, result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      }
      try {
        target[method].apply(target, args.concat(function (result) {
          var error = chrome.runtime.lastError;
          finish(error ? new Error(error.message || 'browser operation failed') : null, result);
        }));
      } catch (error) { finish(error); }
    });
  }
  function storageGet(area, key) { return chromeCall(chrome.storage[area], 'get', [key]); }
  function storageSet(area, value) { return chromeCall(chrome.storage[area], 'set', [value]); }

  // 单实例日志服务。浏览器身份与带超时的存储能力留在宿主，不传整个 chrome 对象。
  var runtimeLogs = self.OmitoneRuntimeLogStore.create({
    read: function () {
      return storageGet('local', RUNTIME_LOGS_KEY).then(function (stored) { return stored && stored[RUNTIME_LOGS_KEY]; });
    },
    write: function (logs) {
      var patch = {}; patch[RUNTIME_LOGS_KEY] = logs;
      return storageSet('local', patch);
    },
    authorize: function (sender, clear) {
      var popup = isPopup(sender);
      if (clear && !popup) return false;
      return (popup ? Promise.resolve({ scope: 'popup' }) : pageScope(sender)).then(function (scope) {
        return ['popup', 'study', 'captcha'].indexOf(scope.scope) !== -1;
      });
    },
    now: Date.now
  });
  function serialGrant(work) {
    var task = grantQueue.then(work);
    grantQueue = task.catch(function () {});
    return task;
  }
  function grantKey(tabId) { return 'omitoneCaptchaGrant:' + tabId; }
  function removeGrant(tabId) { return chromeCall(chrome.storage.session, 'remove', [grantKey(tabId)]); }
  function revokeTab(tabId) {
    tabEpochs[tabId] = (tabEpochs[tabId] || 0) + 1;
    serialGrant(function () { return removeGrant(tabId); }).catch(function () {});
  }
  chrome.tabs.onRemoved.addListener(function (tabId) {
    revokeTab(tabId);
    delete tabStudyMemory[tabId];   // 批次 93：标签页没了，它那一枚的「上次在哪刷课」也就没意义了
  });

  // ── 从学习通页面打开的验证码窗口：自动授一个限时、绑定网址的权限 ──────
  // 只认「opener 是学习通」+「目标网址像验证码页」两条同时成立。
  // 单看网址会被任意网站利用（旧实现就是凭网址猜的），所以 opener 这条不能省。
  var CAPTCHA_URL_RE = /(verif|captcha|checkcode|validate|seccode|yzm|\/code|captchaImage)/i;
  function looksLikeCaptchaUrl(url) {
    if (!policy.httpUrl(url) || policy.isChaoxingUrl(url)) return false;
    return CAPTCHA_URL_RE.test(url);
  }
  function autoGrantTab(tab) {
    if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.openerTabId)) return Promise.resolve();
    var url = tab.url || tab.pendingUrl;
    if (!looksLikeCaptchaUrl(url)) return Promise.resolve();
    var tabId = tab.id;
    return chromeCall(chrome.tabs, 'get', [tab.openerTabId]).then(function (opener) {
      if (!opener || !policy.isChaoxingUrl(opener.url)) return;
      return serialGrant(function () {
        return chromeCall(chrome.storage.session, 'get', [grantKey(tabId)]).then(function (existing) {
          var had = existing && existing[grantKey(tabId)];
          if (had && had.url === url && had.expiresAt > Date.now()) return;   // 已经授过就不重写
          var stored = {};
          stored[grantKey(tabId)] = { url: url, expiresAt: Date.now() + GRANT_MS };
          return storageSet('session', stored);
        });
      });
    }).catch(function () {});
  }
  chrome.tabs.onCreated.addListener(function (tab) { autoGrantTab(tab); });
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (typeof changeInfo.url !== 'string') return;
    revokeTab(tabId);
    noteTabStudyUrl(tabId, changeInfo.url);
    autoGrantTab(tab);
  });

  // ── 每一枚标签页「上一次是在哪一页刷课」的台账（批次 93）───────────────────
  // ⚠️ 为什么这件事只能记在 SW：要判的是「**这一枚**标签页刚才还在刷课，现在被站点顶走了」，
  //    而刷课页在 `mooc1.chaoxing.com`、被顶回去落在 `i.mooc.chaoxing.com` ——
  //    同一枚标签页里不同源的 sessionStorage 是**两块地方**（批次 82-B 的口径），
  //    页面自己写的账换源就读不回来；localStorage 又是跨标签页共享的，分不出"哪一枚"。
  //    只有 SW 的 tabId 视角能把同一枚标签页的两段对上，而且它本来就听着 tabs 事件。
  // ⚠️ 数"有几枚学习页"不需要 "tabs" 权限：`host_permissions` 里有 `*://*.chaoxing.com/*`，
  //    按 2026-11-17 现场实测 `chrome.tabs.query({})` 2/2 枚都读得到 url。
  //    这一格是 AGENTS §2 #15（同一账号一次只许有一枚学习页）唯一能机器核对的地方。
  var STUDY_URL_RE = /\/mycourse\/studentstudy\b/i;
  var STUDY_AWAY_WINDOW_MS = 30 * 60 * 1000;   // 被顶走多久之内还算「这一枚本来是学习页」
  var STUDY_RESCUE_CAP = 2;                     // 一枚标签页最多自己回去几次（防「回去→又被顶→再回去」打转）
  var STUDY_MEMORY_MAX = 32;                    // 台账封个底，别让开过很多标签页的会话无限涨
  var tabStudyMemory = Object.create(null);

  function pruneTabStudyMemory() {
    var ids = Object.keys(tabStudyMemory);
    if (ids.length <= STUDY_MEMORY_MAX) return;
    ids.sort(function (a, b) { return (Number(tabStudyMemory[a].studyAt) || 0) - (Number(tabStudyMemory[b].studyAt) || 0); });
    for (var i = 0; i < ids.length - STUDY_MEMORY_MAX; i++) delete tabStudyMemory[ids[i]];
  }

  /**
   * 只从 `tabs.onUpdated` 的 `changeInfo.url` 喂进来 —— SW 睡着时漏掉的导航不会补记，
   * 那属于「读不出」那一格，调用方拿不到账时必须保守（既不导航也不闭嘴）。
   */
  function noteTabStudyUrl(tabId, url) {
    if (!Number.isInteger(tabId) || typeof url !== 'string') return;
    var now = Date.now();
    var old = tabStudyMemory[tabId];
    var before = old ? (Number(old.rescues) || 0) : 0;
    if (STUDY_URL_RE.test(url)) {
      // 「这一枚之前在别处（awayAt 已记）」且上一次刷课还在时间窗内 —— 走回来就算自愈一次，
      // 上限的存在是为了挡「回去→被顶→再回去」打转（AGENTS §2 #13：这类账只能在真前进时清零）。
      var cameBack = !!(old && old.awayAt && old.studyHref && (now - (Number(old.studyAt) || 0)) <= STUDY_AWAY_WINDOW_MS);
      tabStudyMemory[tabId] = { studyHref: url, studyAt: now, awayAt: 0, rescues: before + (cameBack ? 1 : 0) };
      pruneTabStudyMemory();
      return;
    }
    if (old && old.studyHref && !old.awayAt) old.awayAt = now;   // 第一次被顶走才记时刻
  }

  /**
   * 四态判定（纯函数，`tools/integration-test.js` 把它从本文件里取出来真跑）：
   *   go-back             这一枚刚才在刷课、现在没有别的学习页占着、也没到自愈上限 → 可以在**同一枚标签页内**回去
   *   another-study-tab   另一枚学习页还活着 → 绝不能导航（AGENTS §2 #15：新开等于把前一枚顶下线）
   *   rescue-cap          自己回去过两次还被顶下来 → 交给人的那一格，别再打转
   *   never-study         台账里压根没有这一枚（SW 起来之后它一次都没进过学习页）→ 那是用户自己开的页
   *   study-too-long-ago  上一次刷课早已超出时间窗 → 不回去，但也**不许**说成「从来没刷过」
   *   others-unknown      数不出账号里有几枚学习页 → **不导航**（回去就等于新开，会把另一门顶下线）
   */
  function studyRescueVerdict(memory, otherStudyTabs, now) {
    var m = memory || {};
    var studyAt = Number(m.studyAt) || 0;
    var awayAt = Number(m.awayAt) || 0;
    var rescues = Number(m.rescues) || 0;
    var others = Number(otherStudyTabs);
    // ⚠️ 「数不清有几枚」单独占一格，而且**数不清就不许导航**。这里fail-open 的后果比别处重：
    //    把同一枚标签页送回去 = 账号下同时两枚学习页 = 站点把**另一门**顶下线（AGENTS §2 #15，
    //    2026-11-16 现场就是用户那句「连续开两个课程有一个会被顶下去」）。
    //    所以脏值/负数不能归 0（那等于"确认没有别的学习页"），只能交回调用方说老话。
    var othersUnreadable = !Number.isFinite(others) || others < 0;
    var out = {
      wasStudy: false,
      studyHref: '',
      studyAgeMs: studyAt > 0 ? Math.max(0, now - studyAt) : -1,
      awayMs: awayAt ? Math.max(0, now - awayAt) : 0,
      otherStudyTabs: othersUnreadable ? -1 : others,
      rescues: rescues,
      mayRescue: false,
      reason: 'never-study'
    };
    if (!m.studyHref || studyAt <= 0) return out;
    out.studyAgeMs = now - studyAt;
    if (out.studyAgeMs > STUDY_AWAY_WINDOW_MS) {
      out.reason = 'study-too-long-ago';
      return out;
    }
    out.wasStudy = true;
    out.studyHref = String(m.studyHref);
    if (othersUnreadable) { out.reason = 'others-unknown'; return out; }
    if (others > 0) { out.reason = 'another-study-tab'; return out; }
    if (rescues >= STUDY_RESCUE_CAP) { out.reason = 'rescue-cap'; return out; }
    out.mayRescue = true;
    out.reason = 'go-back';
    return out;
  }

  function isPopup(sender) {
    return popupVerdict(sender).trusted === true;
  }
  /**
   * 「这条消息是不是自家设置弹窗发来的」，并把**不成立时缺了哪一样**一起交出来。
   *
   * 只用两样稳定的证据：`sender.id` 是扩展自己 + `sender.url` 逐字是本扩展的
   * `popup/popup.html`（允许查询串与 `#锚点`）。这两样都由浏览器按**发消息的那个文档**填，
   * 网页改不成我们的源；而 popup.html 不在 `web_accessible_resources` 里，
   * 网页也既进不到这个源、没法把它嵌进 iframe。
   *
   * 故意**不**用下面这些当身份证据（2026-11-12 同学机器：从图标点开弹窗也报
   * 「没认出这是设置弹窗」，作者这台机器同一个包却正常 —— 差的全是形状，不是代码）：
   *   · `sender.tab` / `sender.tab.url`：它说的是"当前活动标签页"，不是发消息的文档。
   *     握着 `activeTab` 时弹窗一打开它就带着学习通页面，握着 `tabs` 时才看得见 URL，
   *     两个字段在不在、指向谁，全看浏览器版本与打开方式；
   *   · `sender.frameId`：部分版本给弹窗压根不带这个字段，所以只在它是**数字且非 0** 时才拒。
   */
  function popupVerdict(sender) {
    if (!sender) return { trusted: false, reason: 'sender-missing' };
    if (sender.id !== chrome.runtime.id) return { trusted: false, reason: 'id-mismatch:' + String(sender.id || '') };
    if (!sender.url) return { trusted: false, reason: 'url-missing' };
    if (typeof sender.frameId === 'number' && sender.frameId !== 0) {
      return { trusted: false, reason: 'frame:' + sender.frameId };
    }
    // **不看 `sender.tab.url`**。它说的是"当前活动标签页"，不是发消息的那个文档：
    // 本扩展申请了 `activeTab`，弹窗一打开浏览器就把活动页挂进 `sender.tab`（学习通页面），
    // 拿它当身份证据必然误判 —— 2026-11-12 同学机器从图标点开弹窗也报「没认出这是设置弹窗」，
    // 而作者这台机器同一个包正常，差的就是这个字段在不在。
    // 去掉它不降低安全性：`sender.id` 与 `sender.url` 都是浏览器按发送文档填的，
    // 网页改不成我们的源，而 popup.html 不在 `web_accessible_resources` 里、也没法被网页嵌。
    var base = chrome.runtime.getURL('popup/popup.html');
    var url = String(sender.url).split('#')[0];
    if (url === base || url.indexOf(base + '?') === 0) return { trusted: true, reason: '' };
    return { trusted: false, reason: 'url-mismatch:' + url.replace(/^chrome-extension:\/\/[^/]+/, '') };
  }
  /**
   * 拒绝时带回「缺的是哪一样」，形如 `popup-deny:frame:3` / `page-deny:url-mismatch:/x.html`。
   *
   * 为什么要它：`forbidden_sender` 在界面上只会翻成一句「没认出这是设置弹窗」，
   * 同学机器上就是这么卡住的 —— 而到底是 `frameId`、`tab.url` 还是 URL 本身对不上，
   * 从外面一个字都读不出来，只能来回猜。这串进日志，用户复制日志就能发出来。
   * 只放形状，不放配置内容、也不放密钥。
   */
  function denyDetail(verdict, sender) {
    var ours = !!(sender && typeof sender.url === 'string'
      && sender.url.indexOf(chrome.runtime.getURL('')) === 0);
    return (ours ? 'popup-deny:' : 'page-deny:') + ((verdict && verdict.reason) || 'unknown');
  }
  // 学习通换章节走的是 pushState：**同一个文档、同一份已注入的脚本**，
  // 而 `sender.url` 冻结在脚本注入那一刻（旧章节），`tab.url` 与 `sender.tab.url` 已是新章节。
  // 实测（2026-11-11 毛概 9000049540→9000049541）：原来那条 `sender.url !== tab.url` 一失配，
  // 这一页从此永久 scope:'none' —— 不答题、不写日志、状态面板不动，
  // 用户看到的「论述题直接卡住」「毛概这一节一直不行」就是它，不是题型的问题。
  // 放宽只放这一种形状，三条同时成立才算：
  //   ① 浏览器实时给出的 sender.tab.url 与 tabs.get 逐字相等（标签页记录自洽，页面伪造不了）；
  //   ② 两边同源；③ 两边都是学习通页面。
  // 验证码那一支不需要另加闸：它只在 `!isChaoxingUrl(tab.url)` 时走到，
  // 而条件 ③ 要求两边都是学习通 —— URL 一对不上这里就返回 null，grant 仍是按 URL 逐字授权。
  function sameDocumentSwitch(sender, tab) {
    if (!sender.tab || sender.tab.url !== tab.url) return false;
    var from = policy.httpUrl(sender.url);
    var to = policy.httpUrl(tab.url);
    if (!from || !to || from.origin !== to.origin) return false;
    return policy.isChaoxingUrl(sender.url) && policy.isChaoxingUrl(tab.url);
  }
  function liveSenderTab(sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab
      || !Number.isInteger(sender.tab.id) || !policy.httpUrl(sender.url)) return Promise.resolve(null);
    return chromeCall(chrome.tabs, 'get', [sender.tab.id]).then(function (tab) {
      if (!tab || tab.pendingUrl || !policy.httpUrl(tab.url)) return null;
      if (sender.url === tab.url || sameDocumentSwitch(sender, tab)) return tab;
      return null;
    }).catch(function () { return null; });
  }
  function pageScope(sender) {
    var tabId = sender && sender.tab && sender.tab.id;
    var epoch = tabEpochs[tabId] || 0;
    return liveSenderTab(sender).then(function (tab) {
      if (!tab || (tabEpochs[tabId] || 0) !== epoch) return { success: true, scope: 'none' };
      if (policy.isChaoxingUrl(tab.url)) return { success: true, scope: 'study', tab: tab };
      return serialGrant(function () {
        return storageGet('session', grantKey(tab.id)).then(function (stored) {
          var grant = stored && stored[grantKey(tab.id)];
          if ((tabEpochs[tabId] || 0) === epoch && grant && grant.url === tab.url && grant.expiresAt > Date.now()) {
            return { success: true, scope: 'captcha', expiresAt: grant.expiresAt, tab: tab };
          }
          return { success: true, scope: 'none' };
        });
      });
    });
  }
  function manageGrant(payload, grant) {
    payload = payload || {};
    if (!Number.isInteger(payload.tabId) || payload.tabId < 0 || !policy.httpUrl(payload.url)
      || policy.isChaoxingUrl(payload.url)) return Promise.resolve(failure('invalid_tab'));
    var epoch = tabEpochs[payload.tabId] || 0;
    return serialGrant(function () {
      return chromeCall(chrome.tabs, 'get', [payload.tabId]).then(function (tab) {
        if (!tab || !tab.active || tab.pendingUrl || tab.url !== payload.url
          || (tabEpochs[payload.tabId] || 0) !== epoch) return failure('tab_changed');
        if (!grant) return removeGrant(tab.id).then(function () { return { success: true, scope: 'none' }; });
        var expiresAt = Date.now() + GRANT_MS;
        var stored = {};
        stored[grantKey(tab.id)] = { url: tab.url, expiresAt: expiresAt };
        return storageSet('session', stored).then(function () {
          if ((tabEpochs[tab.id] || 0) !== epoch) return removeGrant(tab.id).then(function () { return failure('tab_changed'); });
          return { success: true, scope: 'captcha', expiresAt: expiresAt };
        });
      });
    });
  }
  function getConfig() {
    return storageGet('local', 'config').then(function (stored) {
      var config = stored && stored.config;
      return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    });
  }
  function patchConfig(payload, role) {
    payload = payload || {};
    var validation = policy.validatePatch(payload.patch, role);
    if (!validation.success) return Promise.resolve(validation);
    if (payload.expectedFingerprint !== undefined && typeof payload.expectedFingerprint !== 'string') {
      return Promise.resolve(failure('invalid_fingerprint'));
    }
    var task = configQueue.then(function () {
      return getConfig().then(function (current) {
        if (payload.expectedFingerprint !== undefined && payload.expectedFingerprint !== policy.configFingerprint(current)) {
          return failure('stale_config');
        }
        var next = Object.assign({}, current, payload.patch);
        delete next.forceLearn;
        if (payload.patch.apiConnectionFailed === false && !Object.prototype.hasOwnProperty.call(payload.patch, 'apiConnectionError')) {
          delete next.apiConnectionError;
        }
        return storageSet('local', { config: next }).then(function () { return { success: true, config: next }; });
      });
    });
    configQueue = task.catch(function () {});
    return task;
  }

  // One deadline covers headers AND streamed body, even if a mock/server ignores AbortSignal.
  function timedFetch(url, options, timeoutMs, consume) {
    var controller = new AbortController();
    options.signal = controller.signal;
    var timer, status;
    var deadline = new Promise(function (resolve) {
      timer = setTimeout(function () {
        controller.abort();
        var result = failure('timeout', '请求超时 —— 网络不通或服务商长时间无响应');
        if (status !== undefined) result.status = status;
        resolve(result);
      }, timeoutMs);
    });
    var work = Promise.resolve().then(function () { return fetch(url, options); }).then(function (response) {
      status = response.status;
      return consume(response);
    }).catch(function () {
      var result = failure('fetch_failed', '网络不通或响应异常');
      if (status !== undefined) result.status = status;
      return result;
    });
    return Promise.race([deadline, work]).then(function (result) {
      clearTimeout(timer);
      // Cancel unread bodies too (non-2xx, rejected MIME/length, forbidden redirects).
      controller.abort();
      return result;
    });
  }
  function timeoutOf(value, fallback, max) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
  }
  function readLimited(response, limit) {
    var length = response.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      return Promise.reject(new Error('body too large'));
    }
    if (!response.body || typeof response.body.getReader !== 'function') return Promise.reject(new Error('stream unavailable'));
    var reader = response.body.getReader();
    var chunks = [], size = 0;
    function read() {
      return reader.read().then(function (part) {
        if (part.done) {
          var bytes = new Uint8Array(size), offset = 0;
          chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.length; });
          return bytes;
        }
        size += part.value.byteLength;
        if (size > limit) {
          try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (e) {}
          throw new Error('body too large');
        }
        chunks.push(part.value);
        return read();
      });
    }
    return read();
  }
  function apiFetch(payload) {
    payload = payload || {};
    if (!policy.httpUrl(payload.url)) return Promise.resolve(failure('invalid_url'));
    if (payload.headers != null && (typeof payload.headers !== 'object' || Array.isArray(payload.headers))) return Promise.resolve(failure('invalid_headers'));
    return timedFetch(payload.url, { method: payload.method || 'POST', headers: payload.headers || {},
      body: payload.body == null ? undefined : String(payload.body), credentials: 'omit', redirect: 'error' },
    timeoutOf(payload.timeoutMs, 30000, 90000), function (response) {
      return readLimited(response, 8 * 1024 * 1024).then(function (bytes) {
        var text = new TextDecoder().decode(bytes), data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        return { success: response.ok, status: response.status, statusText: response.statusText, text: text, data: data };
      });
    });
  }
  function bytesBase64(bytes) {
    var parts = [];
    for (var i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    return btoa(parts.join(''));
  }
  function fetchImage(payload, scope) {
    payload = payload || {};
    var url = policy.httpUrl(payload.url);
    if (!url) return Promise.resolve(failure('invalid_url'));
    var origin = new URL(scope.tab.url).origin;
    if (scope.scope === 'captcha' && url.origin !== origin) return Promise.resolve(failure('forbidden_origin'));
    return timedFetch(url.href, { credentials: 'include', redirect: scope.scope === 'captcha' ? 'error' : 'follow' },
    timeoutOf(payload.timeoutMs, 60000, 60000), function (response) {
      if (!response.ok) return { success: false, status: response.status, error: '验证码图片拉取失败（HTTP ' + response.status + '）—— 将自动换图重试' };
      var finalUrl = policy.httpUrl(response.url);
      if (!finalUrl || (scope.scope === 'captcha' && finalUrl.origin !== origin)) return failure('forbidden_origin');
      var mime = String(response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (IMAGE_TYPES.indexOf(mime) === -1) return failure('invalid_image_type');
      return readLimited(response, IMAGE_LIMIT).then(function (bytes) {
        return { success: true, dataUrl: 'data:' + mime + ';base64,' + bytesBase64(bytes) };
      }).catch(function () { return { success: false, status: response.status, error: '验证码图片内容不可用或体积超限 —— 将自动换图重试' }; });
    });
  }
  function captchaRequest(payload, sender) {
    if (!payload || Object.keys(payload).some(function (key) { return key !== 'image'; })) return Promise.resolve(failure('invalid_payload'));
    return getConfig().then(function (config) {
      if (config.enableCaptcha === false) return failure('captcha_disabled');
      var request;
      try { request = self.OmitoneCaptcha.buildRequest(config, payload.image); }
      catch (error) { return failure('invalid_captcha', errorText(error)); }
      // Recheck after asynchronous config reads; expired/navigated tabs do not get an API call.
      return pageScope(sender).then(function (current) {
        if (current.scope !== 'study' && current.scope !== 'captcha') return failure('forbidden_sender');
        return apiFetch(request).then(function (response) {
          if (!response.success) {
            // 带上目标主机：401/404 到底是哪家厂商收的请求，以前日志里一个字都没有，
            // 用户只会看到「请求失败（401）」而去反复核对密钥抄没抄错。
            var host = '';
            try { host = new URL(request.url).host; } catch (eHost) {}
            return { success: false, status: response.status,
              error: '验证码识别请求失败（' + (response.status || response.code || '网络不通') +
                '，目标 ' + (host || '未知主机') + '）—— 将自动重试' };
          }
          return self.OmitoneCaptcha.parseResponse(config, response.data);
        });
      });
    });
  }
  function route(message, sender) {
    message = message || {};
    if (message.type === 'ping') return Promise.resolve({ success: true, time: Date.now(), startedAt: startedAt });
    if (message.type === 'runtime_log_append' || message.type === 'runtime_log_clear') return runtimeLogs.handle(message, sender);
    var verdict = popupVerdict(sender);
    var popup = verdict.trusted === true;
    if (message.type === 'grant_captcha' || message.type === 'revoke_captcha') {
      return popup ? manageGrant(message.payload, message.type === 'grant_captcha')
        : Promise.resolve(failure('forbidden_sender', denyDetail(verdict, sender)));
    }
    return (popup ? Promise.resolve({ scope: 'popup' }) : pageScope(sender)).then(function (scope) {
      if (message.type === 'get_page_scope') {
        var result = { success: true, scope: scope.scope === 'popup' ? 'none' : scope.scope };
        if (scope.expiresAt) result.expiresAt = scope.expiresAt;
        return result;
      }
      if (scope.scope === 'none') return failure('forbidden_sender', denyDetail(verdict, sender));
      if (message.type === 'study_tab_state') {
        // 只读：问「这一枚标签页刚才是不是学习页、现在有几枚学习页」。不给 payload，
        // 也不回任何别的标签页的地址 —— 只回本标签页自己的历史与一个计数（批次 93）。
        if (message.payload && Object.keys(message.payload).length) return failure('invalid_payload');
        if (scope.scope !== 'study' || !scope.tab || !Number.isInteger(scope.tab.id)) return failure('forbidden_sender');
        var selfTab = scope.tab;
        return chromeCall(chrome.tabs, 'query', [{ url: '*://*.chaoxing.com/*' }]).then(function (tabs) {
          var others = 0;
          (tabs || []).forEach(function (t) {
            if (t && t.id !== selfTab.id && STUDY_URL_RE.test(String(t.url || ''))) others++;
          });
          var state = studyRescueVerdict(tabStudyMemory[selfTab.id], others, Date.now());
          state.success = true;
          return state;
        });
      }
      if (message.type === 'get_config') {
        return getConfig().then(function (config) {
          return { success: true, config: scope.scope === 'captcha' ? policy.publicConfig(config, 'captcha') : config };
        });
      }
      if (message.type === 'config_patch') {
        return scope.scope === 'popup' || scope.scope === 'study' ? patchConfig(message.payload, scope.scope) : failure('forbidden_sender');
      }
      if (message.type === 'api_fetch') return scope.scope === 'popup' || scope.scope === 'study' ? apiFetch(message.payload) : failure('forbidden_sender');
      if (message.type === 'fetch_image_dataurl') return scope.scope === 'study' || scope.scope === 'captcha' ? fetchImage(message.payload, scope) : failure('forbidden_sender');
      if (message.type === 'captcha_request' || message.type === 'captcha_fetch') {
        return scope.scope === 'study' || scope.scope === 'captcha' ? captchaRequest(message.payload, sender) : failure('forbidden_sender');
      }
      if (message.type === 'storage_set' && (scope.scope === 'study' || popup)) {
        var payload = message.payload;
        if (!payload || Object.keys(payload).length !== 1 || typeof payload.xxtRunning !== 'boolean') return failure('invalid_payload');
        return storageSet('local', { xxtRunning: payload.xxtRunning }).then(function () { return { success: true }; });
      }
      if (message.type === 'check_update' && popup) return { success: true, skipped: true };
      return failure('unknown_message');
    });
  }
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    route(message, sender).then(sendResponse).catch(function () { sendResponse(failure('operation_failed')); });
    return true;
  });
})();
