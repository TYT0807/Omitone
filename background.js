/*
 * Minimal MV3 background for broad Edge compatibility.
 * Keep registration simple: no imports, no startup storage/tabs work.
 */
(function () {
  'use strict';

  var startedAt = Date.now();

  function errorText(error) {
    if (!error) return '';
    return error.message ? String(error.message) : String(error);
  }

  function sendJson(response) {
    return response.text().then(function (text) {
      var data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {}
      return {
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        text: text,
        data: data
      };
    });
  }

  function apiFetch(payload) {
    payload = payload || {};
    var url = String(payload.url || '');
    if (!url) return Promise.resolve({ success: false, error: 'missing url' });

    var options = {
      method: payload.method || 'POST',
      headers: payload.headers || {},
      body: payload.body == null ? undefined : String(payload.body)
    };

    if (typeof AbortController !== 'undefined') {
      var controller = new AbortController();
      options.signal = controller.signal;
      var timeout = setTimeout(function () {
        try { controller.abort(); } catch (e) {}
      }, payload.timeoutMs || 30000);
      return fetch(url, options).then(sendJson).catch(function (error) {
        return { success: false, error: errorText(error) };
      }).then(function (result) {
        clearTimeout(timeout);
        return result;
      });
    }

    return fetch(url, options).then(sendJson).catch(function (error) {
      return { success: false, error: errorText(error) };
    });
  }

  function fetchImageAsDataUrl(payload) {
    payload = payload || {};
    var url = String(payload.url || '');
    if (!url) return Promise.resolve({ success: false, error: 'missing url' });

    // ⚠️ 这个 fetch 原先**没有超时**，而它的兄弟函数 `apiFetch` 有 —— 两个紧挨着的
    //    网络函数，一个加固了一个没加。「新增 await 必须可超时」（AGENTS §2 第 2 条）
    //    在 background 里同样成立：图片服务器接了连接却不回数据时，这个 Promise
    //    永远不 settle，`sendResponse` 也就永远不触发。
    //
    //    调用侧（page.js 的 `bridgeSend`）有 `BRIDGE_TIMEOUT_MS` = 90 秒兜底，
    //    所以用户不会真的永久卡住 —— 但那条桥接链路会一直挂着，而且这个网络连接
    //    也不会被释放（abort 才能真正取消请求，而不是丢给系统回收）。
    //
    //    取 60 秒：比调用侧的 90 秒早一步放弃（不让自己比调用方活得久），
    //    又不至于把"慢但下得完"的小图（验证码图通常几十 KB）切断。
    var options = { credentials: 'include' };
    var timer = null;
    if (typeof AbortController !== 'undefined') {
      var controller = new AbortController();
      options.signal = controller.signal;
      timer = setTimeout(function () {
        try { controller.abort(); } catch (e) {}
      }, payload.timeoutMs || 60000);
    }

    return fetch(url, options)
      .then(function (response) {
        if (!response.ok) {
          return { success: false, error: 'image fetch failed: ' + response.status };
        }
        return response.blob().then(function (blob) {
          return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(new Error('read image failed')); };
            reader.readAsDataURL(blob);
          });
        });
      })
      .then(function (dataUrl) {
        clearTimeout(timer);
        return { success: true, dataUrl: dataUrl };
      })
      .catch(function (error) {
        clearTimeout(timer);
        return { success: false, error: errorText(error) };
      });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    message = message || {};

    if (message.type === 'ping') {
      sendResponse({ success: true, time: Date.now(), startedAt: startedAt });
      return true;
    }

    if (message.type === 'api_fetch') {
      apiFetch(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'fetch_image_dataurl') {
      fetchImageAsDataUrl(message.payload).then(sendResponse);
      return true;
    }

    if (message.type === 'check_update') {
      sendResponse({ success: true, skipped: true });
      return true;
    }

    sendResponse({ success: false, error: 'unknown message: ' + String(message.type || '') });
    return true;
  });
})();
