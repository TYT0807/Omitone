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

    return fetch(url, { credentials: 'include' })
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
        return { success: true, dataUrl: dataUrl };
      })
      .catch(function (error) {
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
