/** Popup-only log view. Host injects DOM, storage/clipboard operations and timers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitonePopupLogView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVELS = ['info', 'warn', 'error', 'debug'];
  function formatTime(time) {
    const date = new Date(time);
    if (!Number.isFinite(date.getTime())) return '--:--:--';
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
  }
  function logList(logs) { return Array.isArray(logs) ? logs.filter(item => item && typeof item === 'object') : []; }
  function metaText(meta) {
    if (!meta) return '';
    try { return ' ' + JSON.stringify(meta); } catch (_) { return ' [日志详情无法序列化]'; }
  }
  function levelOf(item) { return LEVELS.includes(item.level) ? item.level : 'info'; }
  function buildLogsText(logs, version, exportedAt = Date.now()) {
    const list = logList(logs);
    return [
      `Omitone 诊断日志${version ? '（版本 ' + version + '）' : ''}`,
      `导出时间：${formatTime(exportedAt)}`,
      `共 ${list.length} 条（新的在后）`,
      '---',
      ...list.map(item => `[${levelOf(item)}] ${formatTime(item.time)} ${item.message || ''}${metaText(item.meta)}`)
    ].join('\n');
  }

  function create(options) {
    const required = ['readLogs', 'clearLogs', 'writeClipboard', 'notify', 'version', 'now', 'setTimeout', 'clearTimeout'];
    if (!options || required.some(key => typeof options[key] !== 'function') ||
        !options.document || !options.panel || !options.toggleButton) {
      throw new TypeError('Log view requires DOM and explicit IO/timer capabilities');
    }
    const { document, panel, toggleButton, readLogs, clearLogs, writeClipboard, notify, version, now } = options;
    const schedule = options.setTimeout, unschedule = options.clearTimeout;
    let opened = false, disposed = false, epoch = 0, sequence = 0;
    let refreshTimer = null, activeRead = null, clearing = false, copying = false, signature = '';
    const pending = new Set();

    // Waiting can be cancelled; the underlying browser operation may already have happened.
    function operation(action, timeoutMs) {
      let cancel;
      const promise = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true; unschedule(timer); pending.delete(cancel);
          if (error) reject(error); else resolve(value);
        };
        const timer = schedule(() => finish(new Error('操作超时')), timeoutMs);
        cancel = () => finish(new Error('操作已取消'));
        pending.add(cancel);
        Promise.resolve().then(() => { if (!settled) return action(); }).then(
          value => finish(null, value), error => finish(error));
      });
      return { promise, cancel };
    }
    function stopRefresh() {
      if (refreshTimer !== null) { unschedule(refreshTimer); refreshTimer = null; }
    }
    function invalidateRead() {
      sequence++;
      if (activeRead) { activeRead.cancel(); activeRead = null; }
    }
    function visibility(value) {
      opened = value;
      panel.classList.toggle('show', opened);
      toggleButton.textContent = opened ? '隐藏日志' : '查看日志';
      toggleButton.setAttribute('aria-expanded', String(opened));
    }
    function textNode(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    }
    function render(logs, error) {
      const list = logList(logs);
      const entries = list.slice().reverse().map(item => ({
        time: formatTime(item.time), level: levelOf(item), text: String(item.message || '') + metaText(item.meta)
      }));
      const failure = error == null ? null : '日志读取失败：' + String(error.message || error).slice(0, 300);
      const nextSignature = JSON.stringify([failure, entries]);
      if (nextSignature === signature) return;
      const fragment = document.createDocumentFragment();
      if (failure || !entries.length) fragment.appendChild(textNode('div', 'log-item', failure || '暂无日志'));
      else entries.forEach(item => {
        const row = document.createElement('div'); row.className = 'log-item';
        row.appendChild(textNode('span', 'log-time', item.time));
        row.appendChild(textNode('span', 'log-level ' + item.level, '[' + item.level + ']'));
        row.appendChild(document.createTextNode(' ' + item.text));
        fragment.appendChild(row);
      });
      panel.replaceChildren(fragment);
      signature = nextSignature;
    }
    function later() {
      stopRefresh();
      if (!disposed && opened && !clearing) {
        refreshTimer = schedule(() => { refreshTimer = null; refresh(); }, 1500);
      }
    }
    async function refresh() {
      if (disposed || !opened || clearing) return false;
      stopRefresh(); invalidateRead();
      const mySequence = sequence, myEpoch = epoch;
      const task = operation(readLogs, 5000); activeRead = task;
      const current = () => !disposed && opened && !clearing && myEpoch === epoch && mySequence === sequence;
      try {
        const logs = await task.promise;
        if (!current()) return false;
        render(logs); return true;
      } catch (error) {
        if (current()) render([], error);
        return false;
      } finally {
        if (activeRead === task) activeRead = null;
        if (current()) later();
      }
    }
    function open() {
      if (disposed) return Promise.resolve(false);
      if (!opened) { epoch++; visibility(true); }
      return refresh();
    }
    function close() {
      if (disposed) return;
      epoch++; visibility(false); stopRefresh(); invalidateRead();
    }
    async function clear() {
      if (disposed || clearing) return false;
      clearing = true; epoch++; stopRefresh(); invalidateRead();
      try {
        const response = await operation(clearLogs, 20000).promise;
        if (disposed) return false;
        if (!response || response.success !== true) { notify('日志清空失败，请稍后重试'); return false; }
        render([]); notify('日志已清空'); return true;
      } catch (_) {
        if (!disposed) notify('日志清空失败，请稍后重试');
        return false;
      } finally { clearing = false; if (!disposed && opened) later(); }
    }
    async function copy() {
      if (disposed || copying || clearing) return false;
      copying = true;
      const myEpoch = epoch;
      const current = () => !disposed && !clearing && myEpoch === epoch;
      try {
        let logs;
        try { logs = logList(await operation(readLogs, 5000).promise); }
        catch (_) { if (current()) notify('日志读取失败'); return false; }
        if (!current()) return false;
        if (!logs.length) { notify('暂无日志'); return false; }
        let label = '';
        try { label = version(); } catch (_) {}
        try {
          await operation(() => writeClipboard(buildLogsText(logs, label, now())), 5000).promise;
          if (!current()) return false;
          notify(`已复制 ${logs.length} 条日志`); return true;
        } catch (_) {
          if (!current()) return false;
          if (!opened) { epoch++; visibility(true); }
          render(logs); later();
          notify('复制失败，请在上方日志里手动选中'); return false;
        }
      } finally { copying = false; }
    }
    function dispose() {
      if (disposed) return;
      close(); disposed = true;
      [...pending].forEach(cancel => cancel());
    }
    visibility(false);
    return Object.freeze({ open, close, refresh, clear, copy, dispose,
      toggle: () => { if (opened) { close(); return Promise.resolve(false); } return open(); } });
  }
  return Object.freeze({ create, buildLogsText, formatTime });
});