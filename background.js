/** Classic MV3 worker. Privileged operations are authorized from browser-owned sender/tab state. */
importScripts('libs/api-url.js', 'libs/prompt.js', 'libs/thinking.js', 'libs/runtime-policy.js', 'libs/captcha.js');
(function () {
  'use strict';
  var policy = self.OmitonePolicy;
  var startedAt = Date.now();
  var configQueue = Promise.resolve();
  var grantQueue = Promise.resolve();
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
  chrome.tabs.onRemoved.addListener(revokeTab);

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
    autoGrantTab(tab);
  });

  function isPopup(sender) {
    // 扩展自己的页面都算「可信 UI」：popup 窗口、`?play=1` 的沉浸式窗口，
    // 以及被当成普通标签页打开的 popup.html（测试和"在标签页里打开"都会这样）。
    // 判据是**同源 + 同一个路径**，并允许查询串 —— 之前要求"无 tab 且 URL 完全相等"，
    // 结果带 `?ui=fancy` 或作为标签页打开时全被当成外站，保存设置直接 forbidden。
    if (!sender || sender.id !== chrome.runtime.id || !sender.url) return false;
    // 只认顶层文档：网页里嵌 iframe 时 sender.tab.url 是网页地址，这里会直接拒掉
    if (sender.frameId !== 0) return false;
    if (sender.tab && String(sender.tab.url || '').indexOf('chrome-extension://') !== 0) return false;
    var base = chrome.runtime.getURL('popup/popup.html');
    return sender.url === base || sender.url.indexOf(base + '?') === 0;
  }
  function liveSenderTab(sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab
      || !Number.isInteger(sender.tab.id) || !policy.httpUrl(sender.url)) return Promise.resolve(null);
    return chromeCall(chrome.tabs, 'get', [sender.tab.id]).then(function (tab) {
      if (!tab || tab.pendingUrl || !policy.httpUrl(tab.url) || sender.url !== tab.url) return null;
      return tab;
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
        var result = failure('timeout', 'request timeout');
        if (status !== undefined) result.status = status;
        resolve(result);
      }, timeoutMs);
    });
    var work = Promise.resolve().then(function () { return fetch(url, options); }).then(function (response) {
      status = response.status;
      return consume(response);
    }).catch(function () {
      var result = failure('fetch_failed', 'network or response failure');
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
      if (!response.ok) return { success: false, status: response.status, error: 'image fetch failed: ' + response.status };
      var finalUrl = policy.httpUrl(response.url);
      if (!finalUrl || (scope.scope === 'captcha' && finalUrl.origin !== origin)) return failure('forbidden_origin');
      var mime = String(response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (IMAGE_TYPES.indexOf(mime) === -1) return failure('invalid_image_type');
      return readLimited(response, IMAGE_LIMIT).then(function (bytes) {
        return { success: true, dataUrl: 'data:' + mime + ';base64,' + bytesBase64(bytes) };
      }).catch(function () { return { success: false, status: response.status, error: 'image body unavailable or too large' }; });
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
          if (!response.success) return { success: false, status: response.status,
            error: 'captcha request failed (' + (response.status || response.code || 'network') + ')' };
          return self.OmitoneCaptcha.parseResponse(config, response.data);
        });
      });
    });
  }
  function route(message, sender) {
    message = message || {};
    if (message.type === 'ping') return Promise.resolve({ success: true, time: Date.now(), startedAt: startedAt });
    var popup = isPopup(sender);
    if (message.type === 'grant_captcha' || message.type === 'revoke_captcha') {
      return popup ? manageGrant(message.payload, message.type === 'grant_captcha') : Promise.resolve(failure('forbidden_sender'));
    }
    return (popup ? Promise.resolve({ scope: 'popup' }) : pageScope(sender)).then(function (scope) {
      if (message.type === 'get_page_scope') {
        var result = { success: true, scope: scope.scope === 'popup' ? 'none' : scope.scope };
        if (scope.expiresAt) result.expiresAt = scope.expiresAt;
        return result;
      }
      if (scope.scope === 'none') return failure('forbidden_sender');
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
