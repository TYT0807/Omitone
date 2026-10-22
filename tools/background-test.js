#!/usr/bin/env node
'use strict';
// Execute the actual classic worker with browser-owned sender/tab state, no FileReader or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function harness(transformWorker) {
  const local = { config: { apiType: 'openai', apiUrl: 'https://api.test', apiKey: 'secret-key', model: 'text-model',
    captchaModel: 'vision-model', enableCaptcha: true, muted: false, forceLearn: true } };
  const session = {};
  const tabs = new Map([[1, { id: 1, active: true, url: 'https://mooc1.chaoxing.com/course' }],
    [2, { id: 2, active: true, url: 'https://captcha.test/check?token=1' }]]);
  let listener, updated, removed, fetchImpl = () => { throw new Error('unexpected fetch'); };
  const calls = [];
  function area(store) {
    return {
      get(key, cb) { queueMicrotask(() => cb({ [key]: copy(store[key]) })); },
      set(values, cb) { queueMicrotask(() => { Object.assign(store, copy(values)); cb(); }); },
      remove(key, cb) { queueMicrotask(() => { delete store[key]; cb(); }); }
    };
  }
  const chrome = {
    runtime: { id: 'test-extension', getURL: value => 'chrome-extension://test-extension/' + value,
      onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: area(local), session: area(session) },
    tabs: { get(id, cb) { queueMicrotask(() => cb(copy(tabs.get(id)))); },
      onUpdated: { addListener: fn => { updated = fn; } }, onRemoved: { addListener: fn => { removed = fn; } } }
  };
  const context = vm.createContext({ chrome, console, URL, Promise, AbortController, Uint8Array, TextDecoder,
    setTimeout, clearTimeout, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: (url, options) => { calls.push({ url, options }); return fetchImpl(url, options); } });
  context.self = context;
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }));
  let worker = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  if (transformWorker) worker = transformWorker(worker);
  vm.runInContext(worker, context, { filename: 'background.js' });
  return { local, session, tabs, context, calls,
    fetch(fn) { fetchImpl = fn; }, update(id, url) { tabs.get(id).url = url; updated(id, { url }); },
    remove(id) { tabs.delete(id); removed(id); },
    send(type, sender, payload) { return new Promise(resolve => listener({ type, payload }, sender, value => resolve(copy(value)))); } };
}
const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup/popup.html' };
const sender = (id, url, frameId = 0) => ({ id: 'test-extension', tab: { id, url: 'https://forged-tab-cache.test' }, frameId, url });
const study = sender(1, 'https://mooc1.chaoxing.com/course');
const captcha = sender(2, 'https://captcha.test/check?token=1');
function response({ status = 200, mime = 'image/png', data = [1, 2, 3], url = 'https://images.test/a.png', length, hang = false, chunks } = {}) {
  return { ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Not Found', url,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? mime : length == null ? null : String(length); } },
    body: { getReader() { let index = 0; const pieces = chunks || [Uint8Array.from(data)];
      return { read() { if (hang) return new Promise(() => {}); return Promise.resolve(index < pieces.length ? { value: pieces[index++], done: false } : { done: true }); }, cancel() { return Promise.resolve(); } }; } } };
}
async function main() {
  const h = harness();
  const p = h.context.OmitonePolicy;
  for (const url of ['https://chaoxing.com/', 'http://mooc1.chaoxing.com/a', 'https://a.b.chaoxing.com:443/']) check('accept exact Chaoxing host ' + url, p.isChaoxingUrl(url));
  for (const url of ['https://evilchaoxing.com/', 'https://chaoxing.com.evil.test/', 'https://chaoxing.com@evil.test/', 'javascript:chaoxing.com', 'file://chaoxing.com/', 'https://chaoxing.com./']) check('reject deceptive host ' + url, !p.isChaoxingUrl(url));
  const publicConfig = p.publicConfig(Object.assign({}, h.local.config, { apiConnectionError: 'secret-key', unknown: 'secret', systemPrompt: 'private', muted: true }), 'study');
  check('public projection has runtime and key-presence only', publicConfig.muted === true && publicConfig.hasApiKey === true && !JSON.stringify(publicConfig).includes('secret') && publicConfig.apiType === undefined && publicConfig.model === undefined && publicConfig.systemPrompt === undefined);
  check('captcha projection is minimal', JSON.stringify(Object.keys(p.publicConfig(h.local.config, 'captcha')).sort()) === '["enableCaptcha","hasApiKey"]');
  check('projection remains safe and idempotent', p.publicConfig(p.publicConfig(h.local.config, 'captcha'), 'captcha').hasApiKey === true);
  check('stable fingerprint disregards object ordering', p.configFingerprint({ apiType: 'openai', model: 'm' }) === p.configFingerprint({ model: 'm', apiType: 'openai' }));
  check('fingerprint normalizes absent fields to empty strings', p.configFingerprint({}) === p.configFingerprint({ captchaModel: '', visionModel: '', systemPrompt: '' }));
  check('runtime status and toggles do not stale API fingerprint', p.configFingerprint(h.local.config) === p.configFingerprint({ ...h.local.config, muted: true, apiConnectionFailed: true, apiConnectionError: 'offline' }));
  for (const field of ['apiType', 'apiUrl', 'apiKey', 'model', 'captchaModel', 'visionModel', 'thinkingLevel']) check('fingerprint detects ' + field, p.configFingerprint(h.local.config) !== p.configFingerprint(Object.assign({}, h.local.config, { [field]: 'changed' })));
  check('study scope uses live tab not sender.tab URL', (await h.send('get_page_scope', study)).scope === 'study');
  check('ungranted captcha has no scope', (await h.send('get_page_scope', captcha)).scope === 'none');
  for (const invalid of [{ ...study, id: 'other-extension' }, { ...study, frameId: 7 }, { ...study, url: 'https://evil.test' }, {}, { ...popup, tab: { id: 1 }, frameId: 0 }]) {
    check('reject spoofed/untrusted API sender', !(await h.send('api_fetch', invalid, { url: 'https://api.test' })).success);
  }
  check('no forbidden sender reached network', h.calls.length === 0);
  check('ping reveals no config', !JSON.stringify(await h.send('ping', {})).includes('secret'));
  check('content cannot grant captcha', !(await h.send('grant_captcha', study, { tabId: 2, url: captcha.url })).success);
  check('other extension page cannot grant captcha', !(await h.send('grant_captcha', { ...popup, url: popup.url + '?fake' }, { tabId: 2, url: captcha.url })).success);
  h.tabs.get(2).active = false;
  check('inactive tab cannot be granted', !(await h.send('grant_captcha', popup, { tabId: 2, url: captcha.url })).success);
  h.tabs.get(2).active = true;
  check('grant rejects mismatched exact href', !(await h.send('grant_captcha', popup, { tabId: 2, url: captcha.url + '#x' })).success);
  check('popup grants exact active tab for ten minutes', (await h.send('grant_captcha', popup, { tabId: 2, url: captcha.url })).expiresAt > Date.now() + 590000);
  check('exact grant authorizes captcha', (await h.send('get_page_scope', captcha)).scope === 'captcha');
  check('captcha config contains no credentials', !(await h.send('get_config', captcha)).config.apiKey);
  check('captcha cannot arbitrary api fetch', !(await h.send('api_fetch', captcha, { url: 'https://evil.test' })).success);
  check('captcha cannot patch config', !(await h.send('config_patch', captcha, { patch: { apiConnectionFailed: true } })).success);
  check('grant does not authorize another tab', (await h.send('get_page_scope', sender(1, captcha.url))).scope === 'none');
  h.session['omitoneCaptchaGrant:2'].expiresAt = Date.now() - 1;
  check('expired grant denied', (await h.send('get_page_scope', captcha)).scope === 'none');
  await h.send('grant_captcha', popup, { tabId: 2, url: captcha.url });
  h.update(2, captcha.url + '#navigation');
  check('URL update revokes grant', (await h.send('get_page_scope', sender(2, captcha.url + '#navigation'))).scope === 'none');
  h.update(2, captcha.url);
  await h.send('grant_captcha', popup, { tabId: 2, url: captcha.url });
  check('content cannot revoke grant', !(await h.send('revoke_captcha', captcha, { tabId: 2, url: captcha.url })).success);
  check('popup revoke succeeds', (await h.send('revoke_captcha', popup, { tabId: 2, url: captcha.url })).success);
  check('revoked grant denied', (await h.send('get_page_scope', captcha)).scope === 'none');
  await h.send('grant_captcha', popup, { tabId: 2, url: captcha.url });
  h.remove(2);
  check('removed tab loses authorization', (await h.send('get_page_scope', captcha)).scope === 'none');
  h.tabs.set(2, { id: 2, active: true, url: captcha.url });
  check('reused tab id does not recover old grant', (await h.send('get_page_scope', captcha)).scope === 'none');
  const patches = await Promise.all([h.send('config_patch', popup, { patch: { muted: true } }),
    h.send('config_patch', study, { patch: { apiConnectionFailed: true, apiConnectionError: 'offline' } }),
    h.send('config_patch', popup, { patch: { playbackRate: 2 } })]);
  check('concurrent patches all accepted', patches.every(x => x.success));
  check('concurrent patches preserve newest fields', h.local.config.muted && h.local.config.apiConnectionFailed && h.local.config.playbackRate === 2 && h.local.config.apiKey === 'secret-key');
  check('patch removes obsolete forceLearn', !('forceLearn' in h.local.config));
  const fingerprint = p.configFingerprint(h.local.config);
  await h.send('config_patch', popup, { patch: { model: 'new-model' } });
  check('stale status update rejected without overwriting config', (await h.send('config_patch', study, { patch: { apiConnectionFailed: false }, expectedFingerprint: fingerprint })).code === 'stale_config' && h.local.config.apiConnectionFailed);
  check('fresh status patch accepted', (await h.send('config_patch', study, { patch: { apiConnectionFailed: false }, expectedFingerprint: p.configFingerprint(h.local.config) })).success);
  check('clearing API failure removes old error', !('apiConnectionError' in h.local.config));
  for (const patch of [{ playbackRate: 0 }, { muted: 'yes' }, { apiUrl: 'file:///private' }, { apiType: 'unknown' }, { thinkingLevel: 'max' }, { extraField: true }, { forceLearn: true }, { taskGiveUpAttempts: 0.5 }, { apiKey: 'key\r\nheader' }]) check('invalid popup patch rejected ' + JSON.stringify(patch), !(await h.send('config_patch', popup, { patch })).success);
  check('study cannot modify model', (await h.send('config_patch', study, { patch: { model: 'stolen' } })).code === 'forbidden_patch');
  check('storage_set rejects all but boolean running flag', !(await h.send('storage_set', study, { config: {} })).success && !(await h.send('storage_set', study, { xxtRunning: 1 })).success);
  check('storage_set accepts running flag for study', (await h.send('storage_set', study, { xxtRunning: true })).success && h.local.xxtRunning === true);
  for (const url of ['file:///a', 'data:image/png;base64,AQID', 'javascript:1']) check('image rejects non-http protocol ' + url, !(await h.send('fetch_image_dataurl', study, { url })).success);
  h.fetch(() => Promise.resolve(response()));
  let image = await h.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png' });
  check('image 200 becomes data URL without FileReader', image.success && image.dataUrl === 'data:image/png;base64,AQID' && h.context.FileReader === undefined);
  h.fetch(() => Promise.resolve(response({ status: 404 })));
  image = await h.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png' });
  check('image 404 preserves failure and status', image.success === false && image.status === 404 && !image.dataUrl);
  for (const mime of ['image/svg+xml', 'text/html', '', 'application/octet-stream']) {
    h.fetch(() => Promise.resolve(response({ mime })));
    check('image MIME rejected ' + mime, !(await h.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png' })).success);
  }
  h.fetch(() => Promise.resolve(response({ length: 2097153 })));
  check('Content-Length blocks oversized body', !(await h.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png' })).success);
  h.fetch(() => Promise.resolve(response({ chunks: [new Uint8Array(1500000), new Uint8Array(600000)] })));
  check('stream size limit blocks misleading/missing length', !(await h.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png' })).success);
  h.fetch(() => Promise.resolve(response({ hang: true })));
  image = await h.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png', timeoutMs: 15 });
  check('image body timeout settles and aborts', image.code === 'timeout' && image.status === 200 && h.calls.at(-1).options.signal.aborted);
  h.fetch(() => new Promise(() => {}));
  check('image headers timeout settles and aborts', (await h.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png', timeoutMs: 15 })).code === 'timeout' && h.calls.at(-1).options.signal.aborted);
  await h.send('grant_captcha', popup, { tabId: 2, url: captcha.url });
  let count = h.calls.length;
  check('captcha images reject foreign origin before fetch', !(await h.send('fetch_image_dataurl', captcha, { url: 'https://evil.test/a.png' })).success && h.calls.length === count);
  h.fetch(() => Promise.resolve(response({ url: 'https://evil.test/redirect.png' })));
  check('captcha image rejects external final response URL', !(await h.send('fetch_image_dataurl', captcha, { url: 'https://captcha.test/a.png' })).success);
  h.fetch(() => Promise.resolve(response({ url: 'https://captcha.test/a.png' })));
  check('captcha image allows same-origin raster', (await h.send('fetch_image_dataurl', captcha, { url: 'https://captcha.test/a.png' })).success);
  check('captcha redirect request fails closed', h.calls.at(-1).options.redirect === 'error');
  count = h.calls.length;
  check('captcha request rejects injected endpoint/header', !(await h.send('captcha_request', captcha, { image: 'data:image/png;base64,AQID', url: 'https://evil.test', headers: {} })).success && h.calls.length === count);
  for (const image of ['data:image/svg+xml;base64,AQID', 'data:image/png;base64,!', 'https://captcha.test/a.png']) check('invalid OCR image rejected', !(await h.send('captcha_request', captcha, { image })).success);
  for (const apiType of ['openai', 'claude', 'gemini']) {
    Object.assign(h.local.config, { apiType, apiUrl: 'https://saved-provider.test', apiKey: 'saved-key', model: 'text-model', captchaModel: 'vision-model' });
    const data = apiType === 'openai' ? { choices: [{ message: { content: ' ABC ' } }] } : apiType === 'claude' ? { content: [{ type: 'text', text: ' ABC ' }] } : { candidates: [{ content: { parts: [{ text: ' ABC ' }] } }] };
    h.fetch(() => Promise.resolve(response({ mime: 'application/json', data: Buffer.from(JSON.stringify(data)) })));
    const result = await h.send('captcha_request', captcha, { image: 'data:image/png;base64,AQID' });
    const call = h.calls.at(-1);
    check('saved ' + apiType + ' captcha request preserves text protocol', result.success && result.data === 'ABC' && call.url.startsWith('https://saved-provider.test/') && (call.options.body.includes('vision-model') || call.url.includes('vision-model')) && !JSON.stringify(result).includes('saved-key'));
    check('OCR prompt comes from single shared prompt library ' + apiType, call.options.body.includes(h.context.OmitonePrompt.CAPTCHA_PROMPT));
  }
  h.local.config.enableCaptcha = false;
  check('disabled captcha never spends request', !(await h.send('captcha_request', captcha, { image: 'data:image/png;base64,AQID' })).success);
  h.fetch(() => Promise.resolve(response({ mime: 'application/json', data: Buffer.from('{"ok":true}') })));
  check('popup API fetch supported', (await h.send('api_fetch', popup, { url: 'https://api.test', body: '{}' })).data.ok);
  h.fetch(() => Promise.resolve(response({ status: 404, mime: 'application/json', data: Buffer.from('{"error":"missing"}') })));
  check('API non-2xx retains status and JSON', (await h.send('api_fetch', study, { url: 'https://api.test', body: '{}' })).status === 404);
  h.fetch(() => Promise.resolve(response({ hang: true })));
  check('API body timeout aborts after headers', (await h.send('api_fetch', study, { url: 'https://api.test', timeoutMs: 15 })).code === 'timeout');
  // Negative controls mutate only the VM source, never the shared working tree.
  function mutation(source, anchor, replacement) {
    assert.ok(source.includes(anchor), 'mutation anchor must actually exist');
    return source.replace(anchor, replacement);
  }
  const badFrame = harness(source => mutation(source, 'sender.frameId !== 0', 'false'));
  badFrame.fetch(() => Promise.resolve(response({ mime: 'application/json', data: Buffer.from('{}') })));
  const frameProbe = await badFrame.send('api_fetch', { ...study, frameId: 7 }, { url: 'https://api.test' });
  assert.throws(() => assert.equal(frameProbe.success, false), assert.AssertionError);
  check('negative control detects removed top-frame authorization', frameProbe.success === true);
  const bad404 = harness(source => mutation(source,
    "if (!response.ok) return { success: false, status: response.status, error: 'image fetch failed: ' + response.status };",
    "if (!response.ok) return { success: true, status: response.status, dataUrl: 'bad' };"));
  bad404.fetch(() => Promise.resolve(response({ status: 404 })));
  const statusProbe = await bad404.send('fetch_image_dataurl', study, { url: 'https://images.test/a.png' });
  assert.throws(() => assert.equal(statusProbe.success, false), assert.AssertionError);
  check('negative control detects false-success image 404 regression', statusProbe.success === true);
  const badProjection = harness();
  const project = badProjection.context.OmitonePolicy.publicConfig;
  badProjection.context.OmitonePolicy.publicConfig = config => ({ ...project(config, 'study'), apiKey: config.apiKey });
  const secretProbe = badProjection.context.OmitonePolicy.publicConfig(badProjection.local.config, 'study');
  assert.throws(() => assert.equal(secretProbe.apiKey, undefined), assert.AssertionError);
  check('negative control detects credential projection leak', secretProbe.apiKey === 'secret-key');
  console.log('\n' + passed + ' background assertions passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
