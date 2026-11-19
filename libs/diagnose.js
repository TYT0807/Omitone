/**
 * 本地自愈「医生」的判断层 —— 读运行日志环（200 条）→ 规则判断 → 有界的结论与建议。
 *
 * 为什么单独成一个 lib 而不是写在弹窗里：同一份判断要在**三处**用 ——
 * 弹窗的「诊」卡片、上课页她自己开口那一句、以及集成测试（Node 直接 require）。
 * 抄三份必然分叉（本项目对"两份真源"的教训见 popup/pet-game.js 的台词池注释）。
 *
 * 三条硬约束（用户原话：输出必须有界，不然面板装不下、容易崩）：
 *   - 结论条数有上限（MAX_FINDINGS），每条的标题/取证/建议各自限长；
 *   - **只读**：本文件不点任何东西、不改任何配置、不发请求 —— 它只说"是什么、怎么办"，
 *     动手的按钮由界面那一层挂现有的动作（重载这一页 / 打开 Key 那一格，见 popup/popup.js 的 petDiagAction）；
 *   - 任何畸形输入都不许抛：读不出就交 `verdict:'unknown'`，**绝不把"读不出"说成"没问题"**
 *     （AGENTS §2 #12 那一族 —— 压成两态迟早变成"我有一科一直没刷"）。
 *
 * ⚠️ 规则里的 needle **必须是源码里真的写出去那句英文**（AGENTS §2 #22：
 *   按中文语义猜一组词去数，结果是四格全 0 条）。新增规则前先在
 *   `src/page/*.js` / `content.js` / `background.js` 里 grep `emitRuntimeLog(` 把真名抄回来，
 *   `selfCheck()` 里那几格假日志就是照抄的原文，改名字它会当场红。
 *
 * 同时兼容 content script 隔离世界（挂 self.OmitoneDiagnose）与 Node（module.exports）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitoneDiagnose = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 有界输出的几个数 ────────────────────────────────────────────────
  var MAX_FINDINGS = 4;        // 卡片最多四条；再多人类不会读
  var TITLE_MAX = 26;
  var ADVICE_MAX = 72;
  var EVIDENCE_MAX = 96;
  var DIGEST_MAX = 900;        // 交给模型解释时的那份摘要（也是"别把 200 条日志原样塞进提示词"）
  var DEFAULT_WINDOW_MS = 30 * 60 * 1000;
  var MIN_IDLE_WINDOW_MS = 5 * 60 * 1000;   // 「没看到推进」这条至少要攒满 5 分钟才许说

  // 推进类事件：出现这些就说明她真的在往前走（「这段时间没推进」那条要用它当尺）
  var PROGRESS_NEEDLES = [
    'study begin', 'study matched job', 'study next unit', 'study finished on page',
    'study quiz fallback completed', 'media source repaired', 'course switch picked next',
    'course home enter chapter', 'discussion reply submitted', 'vote submitted'
  ];

  // ── 规则表 ──────────────────────────────────────────────────────────
  // severity：3=停下活来了 2=这一路走不通 1=可能只是形状 0=正常收尾的话
  // action：'' = 没有安全的自动动作（只能照建议手动做）；其余三个都是**界面里本来就有的按钮**
  var RULES = [
    {
      code: 'bridge-lost', severity: 3, action: 'reload',
      needles: ['page script no response after tag injection', 'scope lost, bridge stopped',
        'page change restart failed', 'content startup failed'],
      title: '页面里的脚本没接上',
      advice: '重新加载扩展，再按 F5 刷新学习通页面 —— 只重载不刷新会全线停'
    },
    {
      code: 'media-dead', severity: 3, action: 'reload',
      needles: ['media pipeline dead', 'media has no source', 'media error', 'media play failed'],
      title: '这一节的视频放不出来',
      advice: '重新加载这一页；还不行就手动点一下播放键，让浏览器认一次用户手势'
    },
    {
      code: 'stuck', severity: 3, action: 'reload',
      needles: ['study stuck:'],
      title: '这一节卡住了，她已停止空转',
      advice: '重新加载这一页；仍不动就手动点一次下一节'
    },
    {
      code: 'captcha-human', severity: 3, action: '',
      needles: ['needs a human', 'stop spending', 'waiting for a human',
        'captcha submit: no strategy worked'],
      title: '验证码要人工过一次',
      advice: '手动把那张验证墙点过去，再让她继续 —— 她已经停止为这道题花钱了'
    },
    {
      code: 'displaced', severity: 3, action: '',
      needles: ['study displaced, gave up', 'study displaced, held back'],
      title: '这一门被站点顶下线了',
      advice: '同一账号一次只能开一门课：先关掉别的学习通标签页，再回来刷这一门'
    },
    {
      code: 'foreign-ext', severity: 2, action: '',
      needles: ['检测到其他浏览器扩展注入了页面资源'],
      title: '有别的扩展在动这一页',
      advice: '先把其它刷课/脚本类扩展停掉 —— 两家抢同一条视频管线会一起卡住'
    },
    {
      code: 'garbled', severity: 2, action: 'reload',
      needles: ['quiz paused: text stays garbled', 'font decrypt miss', 'font decrypt incomplete'],
      title: '题目文字是乱码（字体反爬没解开）',
      advice: '重新加载这一页让字体表重挂一次；反复出现请把这段日志发出来'
    },
    {
      code: 'api-missing', severity: 2, action: 'open-settings',
      needles: ['skip quiz because api unavailable', 'skip popup quiz because api unavailable',
        'api connection failed, skip quiz', 'quiz blocked by api, holding unit'],
      title: '答题没走模型（配置或连接问题）',
      advice: '到设置里补齐 API 地址与 Key，再按「检测连接」验一次'
    },
    {
      code: 'llm-fail', severity: 2, action: 'open-settings',
      needles: ['llm_request rejected (permanent)', 'quiz llm rejected permanently, no retry',
        'llm_request direct failed', 'vision request failed', 'llm_request aborted'],
      title: '问模型失败了',
      advice: '看余额与模型名是否填对；先换成普通对话模型试一轮'
    },
    {
      code: 'watchdog', severity: 2, action: 'reload',
      needles: ['tick watchdog: stuck tick force-released'],
      title: '有一轮卡死后被强制放开',
      advice: '单次能自愈；反复出现就重载扩展 + F5，并把这段日志发出来'
    },
    {
      code: 'quiz-zero', severity: 1, action: 'reload',
      needles: ['quiz scan found 0 questions', 'quiz skipped: no question could be filled'],
      title: '题抠不出来',
      advice: '确认这一节真的有题；重新加载这一页再看一次'
    },
    {
      code: 'wrong-entry', severity: 1, action: '',
      needles: ['study idle declined', 'course home declined', 'study idle: not our page'],
      title: '这一页不是能刷课的页面',
      advice: '从课程目录点进章节，或让她换下一门 —— 停在用户中心/门户页她干不了活'
    },
    {
      code: 'switch-budget', severity: 1, action: 'open-settings',
      needles: ['course switch declined: switch budget used up',
        'course switch declined: auto switch is off'],
      title: '换课被上限或开关挡住了',
      advice: '设置里放开自动换课（或调高上限），也可以手动挑下一门'
    },
    {
      code: 'unsupported', severity: 1, action: '',
      needles: ['unsupported task point type, skipped'],
      title: '有任务点类型她不认识，已跳过',
      advice: '这类任务点可能要手动做一次；把日志里的类型名反馈出来好加上'
    },
    {
      code: 'keepalive', severity: 0, action: '',
      needles: ['audio keepalive stayed suspended'],
      title: '保活音轨没起来（缺一次用户手势）',
      advice: '在页面上随便点一下再开始刷课；不点也不影响正常播放'
    },
    {
      code: 'all-done', severity: 0, action: '',
      needles: ['no course with unfinished task points', 'course finished, back to user center',
        'course finished, auto switch is off'],
      title: '没有还有任务点没做完的课了',
      advice: '这就是刷完了；要把已完成的再刷一遍，去设置里开「已完成任务重学」'
    }
  ];

  function clamp(text, max) {
    var s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /** 把一条日志消息取成可比较的形状（去首尾空白、压连续空格）—— 规则匹配用 */
  function norm(entry) {
    if (!entry || typeof entry !== 'object') return null;
    var msg = typeof entry.message === 'string' ? entry.message.replace(/\s+/g, ' ').trim() : '';
    if (!msg) return null;
    var t = Number(entry.time);
    return {
      msg: msg,
      level: ['info', 'warn', 'error', 'debug'].indexOf(entry.level) >= 0 ? entry.level : 'info',
      time: Number.isFinite(t) && t > 0 ? t : 0
    };
  }

  /** 找出一条规则命中了几次、最后一次在什么时候（取证只报这两个数，不抄原话全文） */
  function hitOf(items, needles) {
    var count = 0, lastAt = 0, lastMsg = '';
    for (var i = 0; i < items.length; i += 1) {
      for (var j = 0; j < needles.length; j += 1) {
        if (items[i].msg.indexOf(needles[j]) !== -1) {
          count += 1;
          if (items[i].time >= lastAt) { lastAt = items[i].time; lastMsg = items[i].msg; }
          break;
        }
      }
    }
    return { count: count, lastAt: lastAt, lastMsg: lastMsg };
  }

  function hasProgress(items) {
    for (var i = 0; i < items.length; i += 1) {
      for (var j = 0; j < PROGRESS_NEEDLES.length; j += 1) {
        if (items[i].msg.indexOf(PROGRESS_NEEDLES[j]) !== -1) return true;
      }
    }
    return false;
  }

  /**
   * 主入口。
   * @param {Array} logs 运行日志环（`omitoneRuntimeLogs` 那一份，条目 {time,level,message,meta}）
   * @param {Object} [opts] { now:毫秒, windowMs:只看这段时间内的日志 }
   * @returns {{verdict:string, findings:Array, stats:Object}}
   *   verdict 四态，各自单独占一格、不许互相压（AGENTS §2 #12 同一族）：
   *     'issue'   有要处理的（severity ≥ 1）
   *     'note'    只是报个平安/提醒（全篇 severity 0，比如"这门刷完了"）
   *     'healthy' 这段时间没发现问题
   *     'unknown' **读不出**（日志环空 / 形状不对）—— 绝不当成"没问题"
   *   stats.maxSeverity：最硬那一格有多硬，页面她自己开口只在 ≥2 时才开（别为一条提醒打断刷课）
   */
  function analyze(logs, opts) {
    var o = opts || {};
    var now = Number(o.now) > 0 ? Number(o.now) : Date.now();
    var windowMs = Number(o.windowMs) > 0 ? Number(o.windowMs) : DEFAULT_WINDOW_MS;
    var stats = {
      total: 0, readable: 0, skipped: 0, errors: 0, warns: 0,
      windowMs: windowMs, spanMs: 0, inWindow: 0, progress: false, maxSeverity: -1
    };
    // ---- 「读不出」单独占一格：不是数组 / 空环 / 全是畸形条目，一律不许说成"没问题" ----
    if (!Array.isArray(logs) || !logs.length) {
      return { verdict: 'unknown', findings: [], stats: stats, note: '日志环是空的或读不出来' };
    }
    stats.total = logs.length;
    var all = [];
    for (var i = 0; i < logs.length; i += 1) {
      var n = norm(logs[i]);
      if (!n) { stats.skipped += 1; continue; }
      stats.readable += 1;
      if (n.level === 'error') stats.errors += 1;
      if (n.level === 'warn') stats.warns += 1;
      all.push(n);
    }
    if (!stats.readable) {
      return { verdict: 'unknown', findings: [], stats: stats, note: '日志条目形状都对不上' };
    }
    var times = all.map(function (x) { return x.time; }).filter(function (x) { return x > 0; });
    if (times.length) stats.spanMs = Math.max.apply(null, times) - Math.min.apply(null, times);
    var since = now - windowMs;
    var items = all.filter(function (x) { return !x.time || x.time >= since; });
    stats.inWindow = items.length;
    stats.progress = hasProgress(items);

    var found = [];
    for (var r = 0; r < RULES.length; r += 1) {
      var rule = RULES[r];
      var hit = hitOf(items, rule.needles);
      if (!hit.count) continue;
      found.push({
        code: rule.code, severity: rule.severity, action: rule.action,
        title: clamp(rule.title, TITLE_MAX), advice: clamp(rule.advice, ADVICE_MAX),
        count: hit.count, lastAt: hit.lastAt,
        evidence: clamp(hit.lastMsg, EVIDENCE_MAX)
      });
    }
    // 「这段时间没看到刷课推进」：只在窗口够长、日志够多、且**没有任何更硬的结论**时才补这一条
    if (!found.length && windowMs >= MIN_IDLE_WINDOW_MS && stats.inWindow >= 3 && !stats.progress) {
      found.push({
        code: 'no-progress', severity: 1, action: '', title: '这段时间没看到刷课推进',
        advice: '看右下角面板是不是暂停了，或者这一页根本不是学习页',
        count: stats.inWindow, lastAt: now, evidence: ''
      });
    }
    if (!found.length) return { verdict: 'healthy', findings: [], stats: stats };
    found.sort(function (a, b) {
      if (b.severity !== a.severity) return b.severity - a.severity;
      return b.lastAt - a.lastAt;
    });
    // 四态里最容易被压掉的是最后两态：**全是"提醒"级（severity 0）时不许说成"有要处理的"**，
    // 否则界面把"刷完了"渲染成一条警报，而她其实只是报个平安。
    stats.maxSeverity = found[0].severity;
    return {
      verdict: found[0].severity >= 1 ? 'issue' : 'note',
      findings: found.slice(0, MAX_FINDINGS), stats: stats, totalRules: found.length
    };
  }

  function hhmm(ms) {
    if (!(ms > 0)) return '';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 给"让她用模型解释一句"用的摘要：**只交结论，不交 200 条原话**。
   * 硬上限 DIGEST_MAX 字符 —— 超了就整条丢，不许截半句留个断句子。
   */
  function buildDigest(result, maxChars) {
    var cap = Number(maxChars) > 0 ? Number(maxChars) : DIGEST_MAX;
    if (!result || typeof result !== 'object') return '';
    var heads = {
      unknown: '读不出（日志环空或形状不对）',
      healthy: '没发现问题',
      note: '只有提醒，没有要处理的（' + ((result.findings || []).length) + ' 条）',
      issue: '有 ' + ((result.findings || []).length) + ' 条要处理'
    };
    var head = '本地体检结论：' + (heads[result.verdict] || '形状不认识');
    var lines = [head];
    var used = head.length;
    (result.findings || []).forEach(function (f) {
      var line = '- ' + f.title + '（' + f.count + ' 次' + (f.lastAt ? '，最后 ' + hhmm(f.lastAt) : '') + '）：' + f.advice;
      if (used + line.length + 1 > cap) return;   // 整条丢，不截半句
      lines.push(line); used += line.length + 1;
    });
    return lines.join('\n');
  }

  // ── 自证 ────────────────────────────────────────────────────────────
  // 这一族是"判断"，判断错了比没有判断更害人，所以每条规则都要有一格真日志。
  // ⚠️ fixtures 里的 message **照抄源码里真写出去的那句**（改名字这里当场红）。
  var SELF_CASES = [
    { id: 'empty', logs: [], want: 'unknown', why: '空环不许说成没问题' },
    { id: 'not-array', logs: null, want: 'unknown', why: '读不出单独占一格' },
    { id: 'malformed', logs: [{ x: 1 }, '字符串', null], want: 'unknown', why: '全是畸形条目' },
    { id: 'healthy', logs: [
      { time: 1000, level: 'info', message: 'study begin' },
      { time: 2000, level: 'info', message: 'study matched job' }
    ], want: 'healthy', why: '有推进、无异常' },
    { id: 'bridge', logs: [{ time: 3000, level: 'error', message: 'scope lost, bridge stopped' }],
      want: 'issue', code: 'bridge-lost' },
    { id: 'media', logs: [{ time: 3000, level: 'warn', message: 'media pipeline dead, reload in place' }],
      want: 'issue', code: 'media-dead' },
    { id: 'stuck', logs: [{ time: 3000, level: 'error', message: 'study stuck: 下一节点了没反应，已停止空转' }],
      want: 'issue', code: 'stuck' },
    { id: 'captcha', logs: [{ time: 3000, level: 'error', message: 'standalone captcha stopped, needs a human' }],
      want: 'issue', code: 'captcha-human' },
    { id: 'displaced', logs: [{ time: 3000, level: 'warn', message: 'study displaced, gave up' }],
      want: 'issue', code: 'displaced' },
    { id: 'foreign', logs: [{ time: 3000, level: 'warn', message: '检测到其他浏览器扩展注入了页面资源，可能与视频卡住有关' }],
      want: 'issue', code: 'foreign-ext' },
    { id: 'garbled', logs: [{ time: 3000, level: 'error', message: 'quiz paused: text stays garbled' }],
      want: 'issue', code: 'garbled' },
    { id: 'api', logs: [{ time: 3000, level: 'warn', message: 'skip quiz because api unavailable' }],
      want: 'issue', code: 'api-missing' },
    { id: 'llm', logs: [{ time: 3000, level: 'error', message: 'llm_request rejected (permanent)' }],
      want: 'issue', code: 'llm-fail' },
    { id: 'watchdog', logs: [{ time: 3000, level: 'error', message: 'tick watchdog: stuck tick force-released, loop resumed' }],
      want: 'issue', code: 'watchdog' },
    { id: 'quizzero', logs: [{ time: 3000, level: 'error', message: 'quiz scan found 0 questions' }],
      want: 'issue', code: 'quiz-zero' },
    { id: 'wrongentry', logs: [{ time: 3000, level: 'warn', message: 'study idle declined: 这一页认不出课程结构，不点前进' }],
      want: 'issue', code: 'wrong-entry' },
    { id: 'budget', logs: [{ time: 3000, level: 'warn', message: 'course switch declined: switch budget used up' }],
      want: 'issue', code: 'switch-budget' },
    { id: 'unsupported', logs: [{ time: 3000, level: 'warn', message: 'unsupported task point type, skipped' }],
      want: 'issue', code: 'unsupported' },
    { id: 'keepalive', logs: [{ time: 3000, level: 'warn', message: 'audio keepalive stayed suspended: browser has no user gesture for it' }],
      want: 'note', code: 'keepalive', why: '提醒级不许渲染成警报' },
    { id: 'alldone', logs: [{ time: 3000, level: 'warn', message: 'course finished, auto switch is off' }],
      want: 'note', code: 'all-done', why: '刷完那一句是报平安，不是有活' },
    { id: 'noprog', logs: [
      { time: 1000, level: 'info', message: 'performance profile' },
      { time: 2000, level: 'info', message: 'performance profile' },
      { time: 3000, level: 'info', message: 'performance profile' }
    ], want: 'issue', code: 'no-progress' },
    { id: 'stale-window', stale: true, logs: [
      { time: 1, level: 'error', message: 'study stuck: 下一节点了没反应，已停止空转' }
    ], want: 'healthy', why: '一小时前的旧账不许当现在的结论' },
    { id: 'bounded', logs: (function () {
      var arr = [];
      RULES.forEach(function (r, i) {
        arr.push({ time: 1000 + i, level: 'error', message: r.needles[0] });
      });
      return arr;
    })(), want: 'issue', maxed: true, why: '全中也只能交 4 条' }
  ];

  /** 把 fixtures 里的小偏移时间换算成"刚刚"（或"两小时前"）——
   *  不换算的话所有条目都落在窗口外，`analyze` 会诚实地说"没发现问题"，
   *  而自证要的正是"这一格真被看到了"（AGENTS §5「红 0 条的第一嫌疑人是根本没跑到」）。 */
  function materialize(c, now) {
    if (!Array.isArray(c.logs)) return c.logs;
    var base = (c.stale ? now - 2 * 3600 * 1000 : now - 5 * 60 * 1000);
    return c.logs.map(function (e) {
      if (!e || typeof e !== 'object') return e;
      var clone = {};
      Object.keys(e).forEach(function (k) { clone[k] = e[k]; });
      var off = Number(e.time);
      clone.time = base + (Number.isFinite(off) ? Math.min(Math.abs(off), 60 * 1000) : 0);
      return clone;
    });
  }

  /** @returns {{ok:boolean, total:number, problems:Array}} */
  function selfCheck() {
    var problems = [];
    var now = 1700000000000;
    SELF_CASES.forEach(function (c) {
      var res = analyze(materialize(c, now), { now: now, windowMs: 60 * 60 * 1000 });
      if (res.verdict !== c.want) {
        problems.push(c.id + ': 期望 ' + c.want + '，实得 ' + res.verdict);
        return;
      }
      if (c.code && (!res.findings.length || res.findings[0].code !== c.code)) {
        problems.push(c.id + ': 期望点名 ' + c.code + '，实得 ' + (res.findings[0] || {}).code);
      }
      if (c.maxed && res.findings.length !== MAX_FINDINGS) {
        problems.push(c.id + ': 有界上限没生效，交出 ' + res.findings.length + ' 条');
      }
      res.findings.forEach(function (f) {
        if (f.title.length > TITLE_MAX || f.advice.length > ADVICE_MAX || f.evidence.length > EVIDENCE_MAX) {
          problems.push(c.id + '/' + f.code + ': 输出超长（' + f.title.length + '/' + f.advice.length + '/' + f.evidence.length + '）');
        }
      });
    });
    var d = buildDigest({ verdict: 'issue', findings: [{ title: '甲', count: 2, lastAt: now, advice: '乙' }] });
    if (d.indexOf('甲') === -1 || d.length > DIGEST_MAX) problems.push('digest: 摘要形状不对');
    if (buildDigest(null) !== '') problems.push('digest: 空输入要交空串');
    return { ok: !problems.length, total: SELF_CASES.length + 2, problems: problems };
  }

  return {
    analyze: analyze,
    buildDigest: buildDigest,
    selfCheck: selfCheck,
    RULES: RULES,
    PROGRESS_NEEDLES: PROGRESS_NEEDLES,
    LIMITS: { MAX_FINDINGS: MAX_FINDINGS, TITLE_MAX: TITLE_MAX, ADVICE_MAX: ADVICE_MAX, EVIDENCE_MAX: EVIDENCE_MAX, DIGEST_MAX: DIGEST_MAX }
  };
});
