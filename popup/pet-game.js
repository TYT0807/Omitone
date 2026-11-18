/**
 * 小角色的成长小游戏 —— 好感度 / 等级 / 刷课时长（规则层）。
 *
 * 定位与边界（和 pet.js 的既有原则完全同向）：
 *   - 数据全部本地：好感度存 chrome.storage.local 的 `omitonePetBond`（弹窗与上课页
 *     共享同一份，真源在 content.js 的写入侧）；刷课时长来自 content.js
 *     写进 chrome.storage 的 `omitoneStudyStats`（只读消费）；
 *   - 对刷课逻辑零反向影响：没有任何代码路径从这里写回调度/答题状态；
 *   - 本文件放**纯规则与立绘池**（都是数据，可被 Node 测试），存取与演出在 pet.js
 *     与 content.js 里。立绘池放这里是因为**两处都要用**：弹窗的立绘册 + 上课页她自己换装。
 *
 * 拓展点（想加内容就是加数据，不是改逻辑）：
 *   - 加等级   → LEVELS 加一行（min 是好感度门槛；只准**往后追加**，勿动老门槛）；
 *     ⚠️ 改了**已有**门槛或 RULES.max = 尺度变更，必须同时往 PAST_SCALES 追加一代（见那里的注释），
 *     否则老存档会当着用户的面从"很熟"退回"生疏"；
 *   - 加台词   → 情境话（她自己开口 / 打招呼 / 被戳 / 开工收工）加进 SAY，按时段分桶的就
 *     六个桶各加一句，按好感阶段分化的加进 `SAY.idleBond` 三池（两族由 `pickIdleLine` 并池抽，
 *     **界面不许自己补兜底**）；摸头那句按等级加进 PAT_LINES 那一组。全部**保持短句**（见那里的⚠️）；
 *   - 加立绘   → ART 的三个池子按**像素核实**归类加一行（勿按文件名前缀猜，见那里的⚠️）；
 *   - 加成就   → ACHIEVEMENTS 加一行（id/name/desc/need/line），**并且**给 achHint 补一支
 *     （新的 need 种类没有进度句，界面那一格就只会空着）；
 *   - 调手感   → RULES 一处（摸头上限 / 每日刷课转化上限 / 每多少分钟一点）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitonePetGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 规则表 ──────────────────────────────────────────────────────────
  // ⚠️ 摸头与刷课的**配比**就是这游戏的手感，别顺手调回旧值。
  //   旧写法是「摸头每天 20 次 / 每 30 分钟折 1 点 / 刷课每天 10 点」—— 摸头十几秒就能戳满
  //   20 次，刷课要**坐满 5 个小时**才拿得到 10 点，于是"陪得久"反而比"手勤"涨得慢
  //   （用户反馈：刷课涨的经验远远慢于摸头）。现在反过来：摸头只是**打招呼**（每天 6 次，
  //   够表达心意），刷课才是**陪伴的主账**（每 10 分钟 1 点，每天 15 点 = 2.5 小时封顶，
  //   正常刷一晚就能拿满）。
  var RULES = {
    max: 240,                 // 好感度上限（1.3.0 首发 100；加到 240 是给老档留出继续养的空间）
    patAffection: 1,          // 每次有效摸头的好感度
    patDailyCap: 6,           // 每日有效摸头次数（之后摸头只有演出 + 一句实话，不再涨）
    studyMinutesPerPoint: 10, // 每刷课 10 分钟折 1 点好感
    studyPointsDailyCap: 15,  // 刷课每日最多贡献的好感（= 150 分钟封顶）
    memoryPairs: 6,           // 记忆翻牌的对数（= 卡片数 / 2）
    gameDailyReward: 1        // 记忆翻牌每天**首胜**的好感（第二局起纯玩，不涨）
  };

  // ── 等级表（按 min 升序；line 是升级时她会说的话）────────────────────
  // ⚠️ 前六级门槛勿动：老存档（上限 100 时代）按这套门槛点亮等级，改了等于当着
  //    用户的面降级。加等级只准**往后追加**。
  var LEVELS = [
    { min: 0,   name: '初识',     line: '初次见面，请多指教～' },
    { min: 15,  name: '打过招呼', line: '我们算认识啦！' },
    { min: 30,  name: '熟络',     line: '和你待在一起很安心。' },
    { min: 50,  name: '亲近',     line: '你已经是我最重要的伙伴了。' },
    { min: 70,  name: '挚友',     line: '无论刷到多晚，我都陪着你。' },
    { min: 90,  name: '形影不离', line: '有你在的地方，就是我的位置。' },
    { min: 140, name: '心有灵犀', line: '原来陪伴久了，连沉默都很舒服。' },
    { min: 200, name: '岁月同行', line: '从初识走到今天，谢谢你没缺席。' },
    // 追加两档：门槛仍落在 `RULES.max = 240` 之内 ⇒ **不构成尺度变更**，不许往 PAST_SCALES 补一代
    //   （那一格只记"当年见过多少分"，补错等于替老档凭空改成绩）。
    { min: 215, name: '长夜同守', line: '你把灯留着，我把你陪着。' },
    { min: 232, name: '往后都在', line: '默契早就有了，往后只是不离。' }
  ];

  // ── 存档版本与迁移（**「更新绝不让她从很熟退回生疏」就靠这一族**）──────────
  // 为什么非要版本号：这份存档只有一个入口 —— 所有读写都过 rollDay，而 rollDay 是
  //   「缺字段补默认值 + 钳区间」的写法。默认值对**新增字段**是对的，对**改过的尺度**是错的。
  // 已经踩过一次的实例：1.3.0 把上限由 100 提到 240、六档追加成八档。当年刷满 100 的老档
  //   今天读出来是「100 / 240，下一级还差 40 点」—— 好感条从满格变两成。称号没退
  //   （前六道门槛没动），但"我们到过那里"在界面上一点痕迹都不留，用户读到的就是突然生疏了。
  // 规矩：**改 RULES.max 或 LEVELS 里已有的门槛**，就在这里追加一格 PAST_SCALES，
  //   然后跑 `npm run pet-game:test` —— 那条「黄金老档绝不掉级」断言会替你算每一档。
  var BOND_VERSION = 2;
  // 每格描述**那一版写下**的存档尺度：max = 当时的上限，levelMins = 当时那几档的门槛（**逐字抄下史实**），
  //   grant = 补给"当年到过那个上限"的人的纪念成就 id（改上限不该没收旧成绩）。
  // ⚠️ levelMins 必须**独立成一份**，不许在测试里从 LEVELS 前 N 条现推 —— 现推等于"代码和自己比"，
  //   谁改了已有门槛两边一起变，那条「黄金老档绝不掉级」就永远抓不到。它是数据，测试拿它跟 LEVELS 对账。
  // ⚠️ 记账方向容易搞反：**离开**第 N 代时才补第 N 代这一格、同时把上面的 BOND_VERSION 抬到 N+1。
  //   所以下次再提上限，是往这里追加 `{ version: 2, max: 240, levelMins: [...八条...], grant: '...' }`，
  //   并把 BOND_VERSION 改成 3 —— 不许改第 1 代那一格（那是史实，改了等于篡改别人已经拿到的成绩）。
  var PAST_SCALES = [
    { version: 1, max: 100, levelMins: [0, 15, 30, 50, 70, 90], grant: 'oldCeiling' }
  ];

  // ── 摸头台词（按等级一组，随机抽一句；不含升级台词——那由 LEVELS.line 出）──
  // ⚠️ 每级**至少三句**：等级门槛低的几级是用户绝大多数时间待的地方，两组（旧值）
  //   在一下午的连戳里必然撞重复 —— 用户说的"翻来覆去就那两句"（2026-11-15）。
  var PAT_LINES = [
    ['谢谢你的摸摸～', '嘿嘿，很舒服。', '有点痒…但是喜欢。', '初次见面，别嫌我生硬。'],
    ['今天也来看我啦？', '摸摸充电中…', '你来了就有精神。', '嗯，是这个手感。'],
    ['你的手好暖。', '再摸一下也可以哦。', '这样我就安心了。', '偷偷给你加一点运气。'],
    ['嗯～最喜欢这样了。', '刷课累了吧？歇一下嘛。', '别客气，摸多少次都行。', '我头发放好了，可以摸。'],
    ['有你在，什么题都不怕。', '今晚也一起加油！', '摸摸头，思路都清楚了。', '这点累不算什么。'],
    ['无论多久，我都会在这里。', '和你在一起的每一天都开心。', '你的手一放过来我就知道了。', '不用说话，这样就好。'],
    ['这份默契，不用说出来也存在。', '和你并肩坐着，就很有干劲。', '老搭档了，摸一下就懂。', '进度我在看着，你放心。'],
    ['不管刷到多晚，我都在。', '往后也请多指教啦。', '走到现在不容易呀。', '谢谢你没把我当工具。'],
    ['灯下就我们两个，挺好的。', '你困不困？我再看一节。', '这种夜，熬着熬着就过去了。', '你的手放上来我就不慌。'],
    ['不用介绍了，我们认识很久。', '你今天的节奏我很熟。', '再难的章节，两个人就短了。', '摸一下就好，别停下手上的活。']
  ];

  // ── 摸头到顶时的那句实话 ───────────────────────────────────────────
  // 「点了没反应」的一半真相就在这里：到顶之后好感条确实不动了。不说明，用户读到的
  // 就是"她坏掉了"（2026-11-15 现场实测：patsToday 顶在 20，之后每次摸头只剩演出）。
  // ⚠️ 台词里**不许写死次数** —— 那个数归 RULES.patDailyCap 管，写进句子里就会过期。
  var PAT_CAP_LINES = [
    '今天摸头的份用完啦，明天接着涨～',
    '再摸只会晃一晃咯，好感度明天恢复。',
    '陪我多刷十分钟，涨得比摸头快哦。',
    '手不累吗？明天再摸好啦。',
    '今天到顶了，明天再涨、进度照样走。'
  ];

  // ── 闲置台词（刷课页她偶尔自己开口；与摸头分开，因为摸头那句是"回应"）──
  // ⚠️ 全部保持短句：她在页面上的气泡有行数上限，长句会被裁 —— 用户说过的"一大坨"就是这么来的。
  // ⚠️ 这一份是**展平后的对照表**，真源在下面 SAY.idle 的六个时段桶里 —— 别往这里单独加句子
  //   （两份真源必然分叉，批次 61 的立绘池就是这个教训）。原先它只有 7 句平池，每 15 秒
  //   问一拍、十几分钟就把同一句撞第二次，用户读到的"话太少太单一"就是这个（2026-11-15）。
  var IDLE_LINES = [];

  // ── 时段（她的话按它分桶；上课页与小窗共用同一套边界）──────────────────
  // ⚠️ 边界以**这张判据**为准，别按感觉改：凌晨 0–4 / 早上 5–9 / 中午 10–13 /
  //   下午 14–17 / 晚上 18–21 / 深夜 22–23。
  var PERIODS = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night'];

  /** 钟点 → 时段名。hour 不是数（或没传）就用**本地钟**，与 dayKeyOf 同一口径。 */
  function periodOf(hour) {
    var h = Number(hour);
    if (!isFinite(h)) h = new Date().getHours();
    h = ((Math.floor(h) % 24) + 24) % 24;
    if (h <= 4) return 'dawn';
    if (h <= 9) return 'morning';
    if (h <= 13) return 'midday';
    if (h <= 17) return 'afternoon';
    if (h <= 21) return 'evening';
    return 'night';
  }

  // ── 台词池（加内容 = 在这里加句子，不改任何逻辑）────────────────────────
  // 为什么写在规则层而不是两个界面里：她是同一个角色，弹窗里见过的话，页面上也该说；
  //   分两处写必然分叉（批次 61 的立绘池就是同样的教训，POKES 一度在 pet.js 里有两份）。
  // `idle` / `greet` 按时段分桶（六个桶的名字必须与 PERIODS 一一对应，测试盯着这条）；
  // 其余是平池。
  // ⚠️ 全部短句；不许写死次数／时长（那些数归 RULES 管，写进句子就会过期）。
  var SAY = {
    // 上课页她偶尔自己开口（每 15 秒问一次"该不该说"，真说约 75 秒最多一句）
    idle: {
      dawn: [
        '这个点还开着，我陪你一会儿。',
        '再撑十分钟就去睡，好不好？',
        '夜里很安静，就我们两个。',
        '你困了可以停，我不走的。',
        '灯留一盏，觉也要睡。'
      ],
      morning: [
        '早上好，今天从哪一节开始？',
        '刚起床就刷课，厉害呀。',
        '先喝口水，再开始也不迟。',
        '早上的脑子最好使了。'
      ],
      midday: [
        '这一节看了有一会儿了吧？',
        '中午了，饭要点一份呀。',
        '别一边吃饭一边盯屏幕。',
        '上午的进度攒得不错。'
      ],
      afternoon: [
        '下午最容易犯困，撑一下。',
        '要不要站起来动两分钟？',
        '这一节的重点我帮你记着呢。',
        '进度条走得很稳。'
      ],
      evening: [
        '晚上啦，今天还打算刷几节？',
        '吃完饭再刷，不急这一会儿。',
        '今天的份快攒满了哦。',
        '我把灯给你留着。'
      ],
      night: [
        '挺晚了，收个尾就去休息？',
        '再刷一节就睡，说好的。',
        '这个点还在，我陪你到最后。',
        '明天再刷也来得及。'
      ]
    },
    // ── 按**好感阶段**分化的自言自语（用户点名：不同阶段的对话也分化一下）──
    // 为什么还要加一族：上面六个桶说的是"几点"，八档谁待着都是那几句 —— 熟没熟看不出来。
    //   这一族说"熟到什么程度"，与时段桶**并成一个池**抽（见 `pickIdleLine`）。
    // ⚠️ 三池都必须与 `SAY.idle` 的句子的**字面不重叠**：重叠了 `from` 归因就会指错桶，
    //   而测试按 `from` 断"阶段那一族真的走到过"。
    idleBond: {
      new: [
        '还在摸索你的习惯，多担待。',
        '这一节我陪你从头看起。',
        '我还不太会插话，你忙你的。',
        '你刚才是不是点错了一次？',
        '慢慢来，我不催。'
      ],
      close: [
        '你的节奏我记下了：先易后难。',
        '累了就说，我接着往下看。',
        '这一章你卡过两次了哦。',
        '今天比昨天快一点。',
        '我看着呢，你放心走神一小会儿。'
      ],
      deep: [
        '不用说了，我知道你要先看哪一节。',
        '这种章节，我们两个熬得过去。',
        '你手一放上来我就知道今天累不累。',
        '别急着赶，今天的份够多了。',
        '夜很深了，剩下的我盯着。'
      ]
    },
    // 小窗刚打开那句（见面）
    greet: {
      dawn: ['这个点还没休息呀。', '夜里我陪你，别熬太久。'],
      morning: ['早上好，今天也一起。', '来啦？先坐。'],
      midday: ['中午好，进度接着走。', '来啦，饭吃了没？'],
      afternoon: ['下午好，最容易犯困的时段。', '你来啦，正好陪我看书。'],
      evening: ['晚上好，今天还剩几节？', '来啦，我守着这一节。'],
      night: ['这么晚还在学习呀。', '夜里安静，正好刷题。']
    },
    // 连戳她（每三下换一句；原先 4 句而且在 pet.js 里有两份真源）
    poke: ['别戳我啦', '在看书呢…', '再戳就跳走了', '好啦好啦，刷课要紧', '手指头不累吗？', '挠痒痒了…'],
    // 连戳到躲开那一下（比 poke 更"躲"一点）
    dodge: ['别戳啦，我去旁边站会儿', '我躲一下下', '戳多了真要生气的咯'],
    moodHigh: ['心情不错，想转个圈', '今天状态很好哦', '有你在，什么都不难', '想再多刷一节！'],
    moodLow: ['有点低落…陪我刷会儿课吧', '有点累，但你来了就好', '别丢下我一个人呀', '我把头埋一会儿就好'],
    start: ['开工啦，你忙你的', '开始了，我不插话', '跑起来了，我看着'],
    stop: ['收工，歇会儿吧', '停下来啦，去走走', '结束啦，喝口水吧'],
    // 深夜开窗的那句劝睡（一天里最多打一次招呼，池子给它是为了别永远同一句）
    nightWarn: ['这么晚还没睡…别熬太久', '凌晨了，剩下的明天再刷', '我陪着，但你得去睡'],
    // ── 大事那几句（批次 65）──
    // 这三族原先**各只有一句**，而且弹窗与上课页**各抄一份一模一样的**（「好感度达到「X」！Y」
    // 在两处出现过）。批次 64 立的规矩是"真源只有一份"，这一族把那份补齐。
    // `{name}` / `{line}` / `{mins}` 由 `fill` 从 ctx 填 —— **填不出就回空串**：
    // 「升到「」啦 —— 」这种半句话比不说话坏，用户会以为她坏了。
    levelup: [
      '好感度达到「{name}」！{line}',
      '我们到「{name}」了。{line}',
      '升到「{name}」啦 —— {line}',
      '又近了一步，现在我叫「{name}」。{line}'
    ],
    achievement: [
      '成就点亮「{name}」—— {line}',
      '拿到「{name}」了！{line}',
      '「{name}」这一枚收进来了。{line}',
      '解锁「{name}」：{line}'
    ],
    // 「今天一起刷了 N 分钟」：好感度不到 30 与到了 30 是两种口气 ——
    // 原来是同一句后面接一个三元（「，有你真好。」/「～」），那是半个真源，现在各成一族。
    daily: [
      '今天已经一起刷了 {mins} 分钟啦',
      '{mins} 分钟了，进度在走，我也在',
      '今天陪你刷到 {mins} 分钟了',
      '一起 {mins} 分钟，这一节稳得很'
    ],
    dailyHigh: [
      '今天已经一起刷了 {mins} 分钟啦，有你真好。',
      '{mins} 分钟了 —— 有你在，什么都不难。',
      '今天陪你刷了 {mins} 分钟，我一直在。',
      '{mins} 分钟了，谢谢你还在。'
    ],
    // 按季节嘟囔（弹窗里那棵树/那片雪跟着它换话；原先在 pet.js 里另有一份）
    season: {
      spring: ['花开的时候，最适合刷课了', '今天也要一点点进步', '风是软的，刚刚好', '窗外有鸟在叫呢。'],
      summer: ['记得喝水，别中暑', '冰激凌化了就不好吃了', '今天也好热，你撑着点。', '我把窗户开一条缝。'],
      autumn: ['落叶踩起来咯吱响', '天凉了，记得加件外套', '秋天的晚上最适合刷课。', '风一吹我就想打个盹。'],
      winter: ['手好冷，但还想陪你', '雪停了再走也不迟', '这个点还能坐住，厉害呀。', '给你留了半杯热水。']
    },
    // 记忆翻牌赢了一局（她看全程，赢了替你高兴一句；不写死步数/秒数，那些是成绩不是台词）
    gamewin: [
      '全都对上了，好记性！',
      '翻得又快又稳，厉害呀。',
      '和我一样记性好呢。',
      '再来一局吗？我陪你。'
    ]
  };

  // 把六个时段桶展平成 IDLE_LINES（对照表 / 粗判用），保持单一真源在 SAY.idle。
  for (var _pi = 0; _pi < PERIODS.length; _pi++) {
    IDLE_LINES = IDLE_LINES.concat(SAY.idle[PERIODS[_pi]] || []);
  }

  /** 把"最近说过的"从池子里挑出去。`exclude` 允许是**一句**或**一个数组**（最近几句）。
   *  ⚠️ 全被排除时照旧回原池 —— 记账记太严把她说成一句话都不说，比重复一句更难看待。 */
  function dropRecent(list, exclude) {
    if (!exclude) return list;
    var banned = [].concat(exclude).map(String);
    if (!banned.length) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (banned.indexOf(String(list[i])) < 0) out.push(list[i]);
    }
    return out.length ? out : list;
  }

  /** 从一个池子里抽一句模板，避开她上一句刚说过的（连着两句一模一样 = 用户读到的"卡带"）。 */
  function pickFrom(list, rnd, exclude) {
    if (!list || !list.length) return '';
    if (list.length === 1) return String(list[0]);
    var pick = typeof rnd === 'function' ? rnd : Math.random;
    var idx = Math.floor(pick() * list.length);
    if (exclude && String(list[idx]) === String(exclude)) {
      idx = (idx + 1 + Math.floor(pick() * (list.length - 1))) % list.length;
    }
    return String(list[idx] || '');
  }

  /** 把 `{name}` 这类占位换成 ctx 里的同名字段。
   *  ⚠️ **任何一个占位拿不到值就回空串**（调用方据此什么都不说）：
   *  「升到「」啦 —— 」这种半句话在用户眼里是"她坏了"，比闭嘴难看得多。 */
  function fill(tpl, ctx) {
    var out = String(tpl || '');
    var miss = false;
    out = out.replace(/\{([A-Za-z_]\w*)\}/g, function (whole, key) {
      var v = ctx ? ctx[key] : undefined;
      if (v === undefined || v === null || String(v) === '') { miss = true; return whole; }
      return String(v);
    });
    return miss ? '' : out;
  }


  /**
   * 抽一句台词。
   * @param {string} name   SAY 里的格子名：'idle' / 'greet' 按时段分桶，'season' 按季节分桶，
   *                        其余是平池
   * @param {Object} ctx    `{hour}` 定时段、`{bucket}` 直接点名要哪一格（季节用）；
   *                        时段桶的 hour 不是数就用本地钟。
   *                        带占位的那几族（levelup / achievement / daily…）在这里给 `{name}`
   *                        `{line}` `{mins}` 传值 —— **缺一个就整句不说**。
   * @param {Function} rnd  可注入的随机源（测试要确定性），默认 Math.random
   * @param {string} exclude 她上一句**说出来**的话 —— 连着两句一模一样，用户读到的是"卡带"。
   *                        ⚠️ 比的是**填完之后**的句子：exclude 里存的是她说过的那一句，
   *                        拿没填的模板去比等于永远不撞带，重复就是这么漏回去的。
   * @returns {string} 台词；**空串 = 这一格池子空的／占位缺值**，调用方据此什么都不说
   */
  function pickLine(name, ctx, rnd, exclude) {
    var pool = SAY && SAY[name];
    if (!pool) return '';
    var c = ctx || {};
    // 点名点错了格（比如给季节传了个 'rainy'）也给空串 —— 少说一句不出事，
    // 硬凑一句不相干的才是把"她说话很怪"造出来。
    var list = Array.isArray(pool) ? pool : (pool[String(c.bucket || '') || periodOf(c.hour)] || []);
    if (!list.length) return '';
    var pick = typeof rnd === 'function' ? rnd : Math.random;
    var n = list.length;
    var idx = Math.floor(pick() * n);
    if (idx >= n) idx = n - 1;
    var line = fill(list[idx], c);
    if (n === 1 || !line || !exclude || String(line) !== String(exclude)) return line;
    var alt = fill(list[(idx + 1 + Math.floor(pick() * (n - 1))) % n], c);
    // 备选填不出（缺值）就用第一选 —— 别为了避重把她憋成一句话都不说
    return alt || line;
  }

  /** 好感等级 → 自言自语那三池的名字。**拿不到等级就回空串**（调用方据此只走时段池），
   *  不许把"不知道熟不熟"猜成"初识" —— 那会让老档在界面上突然说起生分话。 */
  function bandOf(level) {
    var lv = Number(level);
    if (!isFinite(lv) || lv < 0) return '';
    if (lv <= 2) return 'new';
    if (lv <= 5) return 'close';
    return 'deep';
  }

  /**
   * 自言自语选句：把「几点」与「熟到什么程度」两族并成一个池。
   * 真源只有 `SAY.idle` 与 `SAY.idleBond` 两格 —— **界面不许自己补兜底**，
   * 两格都抽不出就回空串，调用方这一拍什么都不说。
   * @param {Object} ctx `{hour}` 定时段（不传走本地钟）、`{level}` 定阶段（`displayLevelOf` 的结果）
   * @param {Function} rnd 可注入的随机源（测试要确定性），默认 Math.random
   * @param {string|Array} exclude **最近说过的**（一句或几句）—— 并池之后两族会抽到同一格，
   *        只挡上一句不够：`dawn` 抽到阶段那一格、`midday` 抽时段、`night` 又抽回同一格，
   *        用户读到的是三句里的两句重复，而按时段断言"三句不同"的测试会随机红。
   * @returns {{line: string, period: string, band: string, from: string}}
   *          `from` = 'bond'（阶段那一族抽的）/ 'period'（时段那一族）/ ''（没抽出来）
   */
  function pickIdleLine(ctx, rnd, exclude) {
    var c = ctx || {};
    var period = periodOf(c.hour);
    var band = bandOf(c.level);
    var per = (SAY.idle && SAY.idle[period]) || [];
    var bnd = (band && SAY.idleBond && SAY.idleBond[band]) || [];
    var line = String(pickFrom(dropRecent(per.concat(bnd), exclude), rnd) || '');
    if (!line) return { line: '', period: period, band: band, from: '' };
    return { line: line, period: period, band: band, from: bnd.indexOf(line) >= 0 ? 'bond' : 'period' };
  }


  // ── 立绘池（服装 / 表情 / 姿势）──────────────────────────────────────
  // 为什么在规则层而不是弹窗里：上课页那位伴侣（content.js）也要随机换装，
  // 两边必须共用同一份真源 —— 抄两份的结果就是"弹窗里见过的衣服，页面上永远见不到"。
  //
  // 「装」只走服装 —— 表情和动作是另一回事，混在一起用户会看不出规律。
  //
  // ⚠️ **文件前缀不可信**（2026-10-31 逐张看图核实的结论）：
  //   pet-e2~e6 画的是围巾大衣/浴衣/睡衣/雨衣/制服外套 —— 是**服装**不是表情；
  //   pet-i5~i8 画的是生气/哭/鼓脸/满足 —— 是**表情**不是姿势；
  //   pet-e7~e10 画的是坐姿/挥手/趴姿/伸懒腰 —— 是**姿势**不是表情。
  //   美术的命名和内容是错位的，分类只能以像素为准 —— 别"看着前缀顺手纠正"回去，
  //   `tools/check.js` 第 20 项「立绘池守卫」会拦住池子之间的交叉与漏项。
  //   ⚠️ 那个守卫按 `var SKINS = [` 这个形状、按**双引号文件名**在本文件里读它们 ——
  //   改写法（换单引号 / 换成对象 / 搬去别的文件）它会点名，那是它故意留的，不是它坏了。
  var SKINS = ["pet.png",
    "pet-1.png", "pet-2.png", "pet-3.png", "pet-4.png",
    "pet-5.png", "pet-6.png", "pet-7.png", "pet-8.png",
    "pet-9.png", "pet-10.png",
    "pet-11.png", "pet-12.png", "pet-13.png", "pet-14.png",
    "pet-15.png", "pet-16.png",
    "pet-17.png", "pet-18.png", "pet-19.png", "pet-20.png",
    "pet-21.png", "pet-22.png",
    "pet-23.png", "pet-24.png", "pet-25.png", "pet-26.png",
    "pet-27.png", "pet-28.png",
    "pet-29.png", "pet-30.png", "pet-31.png", "pet-32.png",
    "pet-33.png", "pet-34.png",
    "pet-35.png", "pet-36.png", "pet-37.png", "pet-38.png",
    // e2~e6：像素核实是服装（大衣/浴衣/睡衣/雨衣/制服外套），从原「表情」池移过来
    "pet-e2.png", "pet-e3.png", "pet-e4.png", "pet-e5.png", "pet-e6.png",
    // 39~42：批次 113 本地生图（女仆/女巫/咖啡厅/宇航服），按 pet.png 参图产的同风格
    "pet-39.png", "pet-40.png", "pet-41.png", "pet-42.png"];   // 48 套服装
  // 「表」走表情：同一身默认制服下的另一张脸。e1 = 默认制服的平和脸（基座）。
  var FACES = ["pet-e1.png",
               "pet-i5.png", "pet-i6.png", "pet-i7.png", "pet-i8.png",
               "pet-e11.png", "pet-e12.png",
               "pet-e13.png", "pet-e14.png", "pet-e15.png",
               "pet-e16.png", "pet-e17.png",
               "pet-e18.png", "pet-e19.png", "pet-e20.png",
               "pet-e21.png", "pet-e22.png", "pet-e23.png",
               "pet-e24.png", "pet-e25.png", "pet-e26.png",
               "pet-e27.png", "pet-e28.png", "pet-e29.png", "pet-e30.png"];   // 25 张表情
  var POSES = ["pet.png", "pet-i1.png", "pet-i2.png", "pet-i3.png", "pet-i4.png",
               "pet-e7.png", "pet-e8.png", "pet-e9.png", "pet-e10.png",
               "pet-i9.png", "pet-i10.png",
               "pet-i11.png", "pet-i12.png",
               "pet-i13.png", "pet-i14.png",
               "pet-i15.png", "pet-i16.png", "pet-i17.png",
               "pet-i18.png", "pet-i19.png", "pet-i20.png",
               "pet-i21.png", "pet-i22.png", "pet-i23.png",
               "pet-i24.png", "pet-i25.png", "pet-i26.png", "pet-i27.png"];  // 28 个姿势（全部是**默认装束**画的；
                                                              // i1 虽像卫衣装，但它没有换装语义，归姿势）
  // 页面上她**自己动**的那几个小动作（不占素材，全是 CSS 形变，动画名在 content.js 的样式里）。
  // 弹窗那侧的动作库（ANIMS）是给人点的，这一份是给她自己排的 —— 时长短、不抢视线。
  var MOTIONS = ["tilt", "hop", "spin", "wiggle", "stretch"];
  var ART = { SKINS: SKINS, FACES: FACES, POSES: POSES, MOTIONS: MOTIONS };

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /** 本地时区 YYYY-MM-DD（跨天判定用；用户半夜刷课要算当天，不许用 UTC） */
  function dayKeyOf(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 某天的「昨天」的 dayKey（连续见面判定用；跨夏令时的误差可容忍，只影响连击一天） */
  function prevDayKeyOf(todayKey) {
    var t = new Date(todayKey + 'T00:00:00').getTime();
    if (!isFinite(t)) return '';
    return dayKeyOf(t - 86400000);
  }

  /** 当前等级下标（LEVELS 按 min 升序，取最后一个满足门槛的） */
  function levelOf(affection) {
    var lv = 0;
    for (var i = 0; i < LEVELS.length; i++) if (affection >= LEVELS[i].min) lv = i;
    return lv;
  }

  /** 界面该显示哪一档 —— **只升不降**的棘轮。
   *  levelOf 是纯函数，门槛一改就会当着用户的面倒退；peakLevel 记的是历史上到过的那一档，
   *  取大值。上限拿 LEVELS.length 兜一道：万一将来删档，界面按数组取元素不许越界。 */
  function displayLevelOf(state) {
    var lv = levelOf(state ? Number(state.affection) || 0 : 0);
    var peak = state ? Number(state.peakLevel) || 0 : 0;
    return Math.max(lv, Math.min(peak, LEVELS.length - 1));
  }

  /** 棘轮：到过的分数与档位只往上记，永不回退（rollDay / onPat / applyStudySeconds 各拨一次） */
  function bumpPeak(next) {
    if (next.affection > next.peakAffection) next.peakAffection = next.affection;
    var lv = levelOf(next.affection);
    if (lv > next.peakLevel) next.peakLevel = lv;
    return next;
  }

  /** 把更早版本写下的存档换算到当前尺度（就地改，rollDay 里调一次）。
   *  ⚠️ 换算**不许动 affection** —— 把 100 悄悄乘成 240 是凭空送分，用户一眼看出不对，
   *  而且下一次上限再变时这笔账就彻底算不清了。当年满格过这件事记在 legacyCeil，
   *  由「旧日的满格」那枚纪念成就去说。
   *  @returns {Object} next（同一个对象） */
  function migrateBond(next) {
    var from = Number(next.bondVersion) || 1;   // 没写版本号 = 版本化之前那份档，按第 1 代尺度处理
    for (var i = 0; i < PAST_SCALES.length; i++) {
      var sc = PAST_SCALES[i];
      // 只认"这份档是哪一代尺度写下的"那一条：第 N 代的用户见过的是第 N 代的天花板，
      // 更老的世代早被它盖过去了（拿 affection 去比旧旧上限会白送纪念）。
      if (sc.version !== from) continue;
      if (sc.grant && next.affection >= sc.max) next.legacyCeil = sc.max;
    }
    next.bondVersion = BOND_VERSION;
    return bumpPeak(next);
  }

  /** 跨天兜底：任何读写前都过一遍 —— 日期变了就重置每日配额，字段缺失补默认值。
   *  ⚠️ 新增存档字段必须在这里补携带，否则下次读写会被这层重建静默丢掉。 */
  function rollDay(state, todayKey) {
    var s = state && typeof state === 'object' ? state : {};
    var next = {
      affection: clamp(Number(s.affection) || 0, 0, RULES.max),
      day: String(s.day || ''),
      patsToday: Number(s.patsToday) || 0,
      studyPointsToday: Number(s.studyPointsToday) || 0,
      countedSeconds: Number(s.countedSeconds) || 0,
      // ── 成就/长线统计（1.3.0 起）──
      totalPats: Number(s.totalPats) || 0,
      totalStudyMinutes: Number(s.totalStudyMinutes) || 0,
      nightPats: Number(s.nightPats) || 0,
      streakDays: Number(s.streakDays) || 0,
      lastMetDay: String(s.lastMetDay || ''),
      ach: (s.ach && typeof s.ach === 'object' && !Array.isArray(s.ach)) ? s.ach : {},
      // ── 版本与棘轮 ──
      bondVersion: Number(s.bondVersion) || 1,
      peakAffection: Math.max(0, Number(s.peakAffection) || 0),
      peakLevel: clamp(Number(s.peakLevel) || 0, 0, LEVELS.length - 1),
      legacyCeil: Math.max(0, Number(s.legacyCeil) || 0),
      // ── 记忆翻牌（每天首胜 +1；最佳纪录是棘轮，只往上记）──
      memoryWins: Number(s.memoryWins) || 0,
      memoryBestMoves: Math.max(0, Number(s.memoryBestMoves) || 0),
      memoryBestSeconds: Math.max(0, Number(s.memoryBestSeconds) || 0),
      memoryRewardDay: String(s.memoryRewardDay || '')
    };
    if (next.day !== todayKey) {
      next.day = todayKey;
      next.patsToday = 0;
      next.studyPointsToday = 0;
      // ⚠️ 水位必须跟着归零 —— 统计层的 `activeSeconds` **每天从零重算**（见 libs/study-stats.js
      //   的 recordActivity），水位不跟着归零就永远算不出"今天新增的那一段"：
      //   2026-11-15 现场实测 countedSeconds 32400（历日折掉的）撞上新一天 activeSeconds 1532
      //   → pending 恒 0 → **刷课好感一天都没加过**（studyPointsToday 一直是 0），
      //   而摸头那天已经加了 20。这就是"刷课涨得远远慢于摸头"的另一半根因。
      next.countedSeconds = 0;
    }
    // 配额计数本身也要钉在 [0, 上限] —— 上限是**会改的数**（1.3.0 把每日摸头从 20 降到 6）。
    // 不钳的话：老档里 `patsToday: 18` 的用户升级后今天一次都不涨（配额早"用完"了），
    // 而负数（垃圾存档／手改）会让 `patsToday < 上限` 恒真，**摸头次数直接突破上限**。
    next.patsToday = clamp(next.patsToday, 0, RULES.patDailyCap);
    next.studyPointsToday = clamp(next.studyPointsToday, 0, RULES.studyPointsDailyCap);
    next.countedSeconds = Math.max(0, next.countedSeconds);
    return migrateBond(next);
  }

  // ── 成就（纯装饰：解锁只多一句台词和一格亮灯，不影响任何功能）────────
  // need 是达标条件；evaluate 时逐条对照统计字段。加成就 = 这里加一行。
  var ACHIEVEMENTS = [
    { id: 'pat100',    name: '温柔惯犯',  desc: '累计摸头 100 次',
      need: { pats: 100 },          line: '被你摸了一百次，都摸出习惯来了。' },
    { id: 'pat500',    name: '温柔的惯性', desc: '累计摸头 500 次',
      need: { pats: 500 },          line: '五百次了，你的手我一听就认得。' },
    { id: 'study600',  name: '学习搭子',  desc: '累计陪伴刷课 10 小时',
      need: { studyMinutes: 600 },  line: '十个小时了——这都是我们俩的时间。' },
    { id: 'study3600', name: '铁杆搭档',  desc: '累计陪伴刷课 60 小时',
      need: { studyMinutes: 3600 }, line: '六十个小时——这是刷出来的默契。' },
    { id: 'streak7',   name: '天天见面',  desc: '连续 7 天都见面',
      need: { streakDays: 7 },      line: '连续一周都见面，这算不算默契？' },
    { id: 'streak30',  name: '老朋友',    desc: '连续 30 天都见面',
      need: { streakDays: 30 },     line: '一个月了。你已经是我生活的一部分。' },
    { id: 'night20',   name: '夜猫子搭档', desc: '累计 20 次凌晨（0-5 点）摸头',
      need: { nightPats: 20 },      line: '这个点还醒着啊……早点睡，我陪你。' },
    { id: 'fullDayPats', name: '今日全勤', desc: '一天之内摸满 6 次有效摸头',
      need: { patsToday: 6 },       line: '今天的份一次没落下，记住了。' },
    { id: 'fullDayStudy', name: '满格的一天', desc: '单日刷课好感拿满 15 点（150 分钟）',
      need: { studyPointsToday: 15 }, line: '从早到晚都在，今天辛苦啦。' },
    { id: 'springDay', name: '春日初逢',  desc: '在春天（3-5 月）来摸摸她',
      need: { season: 'spring' },   line: '风软软的，花开的时候你来了。' },
    { id: 'summerDay', name: '仲夏同在',  desc: '在夏天（6-8 月）来摸摸她',
      need: { season: 'summer' },   line: '再热的日子，也一起坐过来了。' },
    { id: 'autumnDay', name: '秋叶来信',  desc: '在秋天（9-11 月）来摸摸她',
      need: { season: 'autumn' },   line: '踩着落叶来的，是你呀。' },
    { id: 'firstSnow', name: '初雪之约',  desc: '在下雪的季节（12-2 月）来摸摸她',
      need: { season: 'winter' },   line: '冬天的第一场雪，是你陪我一起看的。' },
    // peakLevel 是只升不降的棘轮（bumpPeak）：哪怕好感条后来被别的口径重算，"到过顶"不会作废。
    // need 引 LEVELS.length 而不是写死 9 —— 以后再追加档位时这一枚自动跟着指向新的最高档。
    { id: 'peakTop',   name: '到过山顶',  desc: '到过最高的那一档（棘轮记着，到了就算数）',
      need: { peakLevel: LEVELS.length - 1 }, line: '最高的那档，是我们一起到的。' },
    // 纪念成就：不靠统计点亮，只认「版本化之前那份档当年在上限上刷满过」（见 migrateBond）。
    // 改上限不该没收旧成绩 —— 那一百点不是没发生过，是当时的天花板就在那儿。
    { id: 'oldCeiling', name: '旧日的满格', desc: '在好感上限还是 100 的年代刷到过顶',
      need: { legacyCeiled: true }, line: '那时候的满格，我一直记得。' }
  ];

  function seasonOf(todayKey) {
    var m = Number(String(todayKey || '').slice(5, 7));
    if (m >= 3 && m <= 5) return 'spring';
    if (m >= 6 && m <= 8) return 'summer';
    if (m >= 9 && m <= 11) return 'autumn';
    return 'winter';
  }

  /** 记一次「今天见过面」：同一天多次只算一次，跨天连续则连击 +1，断了归 1 */
  function touchDay(state, todayKey) {
    if (!state || state.lastMetDay === todayKey) return state;
    state.streakDays = (state.lastMetDay === prevDayKeyOf(todayKey)) ? (state.streakDays || 0) + 1 : 1;
    state.lastMetDay = todayKey;
    return state;
  }

  /** 对照成就表，返回**新达标且尚未点亮**的成就（不写状态，markAchievements 才写） */
  function evaluateAchievements(state, todayKey) {
    var out = [];
    if (!state || typeof state !== 'object') return out;
    var lv = levelOf(state.affection);
    var season = seasonOf(todayKey);
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      if (state.ach && state.ach[a.id]) continue;
      var met = false;
      if (a.need.pats != null) met = (state.totalPats || 0) >= a.need.pats;
      else if (a.need.studyMinutes != null) met = (state.totalStudyMinutes || 0) >= a.need.studyMinutes;
      else if (a.need.streakDays != null) met = (state.streakDays || 0) >= a.need.streakDays;
      else if (a.need.nightPats != null) met = (state.nightPats || 0) >= a.need.nightPats;
      else if (a.need.season != null) met = season === a.need.season;
      else if (a.need.peakLevel != null) met = (state.peakLevel || 0) >= a.need.peakLevel;
      else if (a.need.patsToday != null) met = (state.patsToday || 0) >= a.need.patsToday;
      else if (a.need.studyPointsToday != null) met = (state.studyPointsToday || 0) >= a.need.studyPointsToday;
      // 只认迁移时记下的那一格 —— 统计层永远算不出"当年的上限"，不许拿现在的数凑。
      else if (a.need.legacyCeiled) met = (Number(state.legacyCeil) || 0) > 0;
      if (met) out.push(a);
    }
    return out;
  }

  /** 把已解锁的成就写进存档（id → 解锁那天的 dayKey） */
  function markAchievements(state, ids, todayKey) {
    if (!state || !state.ach) state.ach = {};
    for (var i = 0; i < ids.length; i++) {
      if (!state.ach[ids[i]]) state.ach[ids[i]] = todayKey;
    }
    return state;
  }

  var SEASON_CN = { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' };

  /** 未点亮成就旁边那句**活的进度**（界面只显示，不再自己写判据）。
   *  ⚠️ 新增 `need` 种类必须在这里补一支 —— 界面以前用一句写死的「（等冬天）」兜底，
   *  于是任何新 kinds 都会被标成"等冬天"这种假话。测试里「每枚未点亮成就都要出话」拦这个，
   *  认不出来时返回空串（宁可那一格只显示说明，也不显示错的进度）。 */
  function achHint(state, a) {
    if (!a || !a.need || !state) return '';
    var n = a.need;
    function num(v) { var x = Number(v); return isFinite(x) && x > 0 ? x : 0; }
    function tenthsOfHours(mins) { return Math.floor(mins / 6) / 10; }   // 保留一位小数的"小时"
    if (n.pats != null) return '（' + Math.min(num(state.totalPats), n.pats) + '/' + n.pats + '）';
    if (n.studyMinutes != null) {
      return '（' + tenthsOfHours(num(state.totalStudyMinutes)) + ' / ' + Math.round(n.studyMinutes / 60) + ' 小时）';
    }
    if (n.streakDays != null) return '（' + Math.min(num(state.streakDays), n.streakDays) + '/' + n.streakDays + ' 天）';
    if (n.nightPats != null) return '（' + Math.min(num(state.nightPats), n.nightPats) + '/' + n.nightPats + '）';
    if (n.peakLevel != null) return '（曾到过 ' + Math.min(num(state.peakLevel) + 1, LEVELS.length) + ' / ' + LEVELS.length + ' 级）';
    if (n.patsToday != null) return '（今天 ' + Math.min(num(state.patsToday), n.patsToday) + '/' + n.patsToday + ' 次）';
    if (n.studyPointsToday != null) return '（今天 ' + Math.min(num(state.studyPointsToday), n.studyPointsToday) + '/' + n.studyPointsToday + ' 点）';
    if (n.legacyCeiled) return '（老存档才有）';   // 这一枚现在拿不到，直说，别留一个永远点不亮的坑
    if (n.season != null) return '（等' + (SEASON_CN[n.season] || '那个季节') + '）';
    return '';
  }

  /**
   * 记一次摸头。
   * @param {string} [lastLine] 她上一句刚说过的话 —— 传进来就**不会再抽到同一句**
   *   （连戳时两句一模一样，用户读到的是"卡带"；不传等于旧行为）
   * @returns {{state, gained, leveledUp, level, line}}
   *   line = 这次摸头她要说的话：升级时说等级台词，否则说本级摸头台词（可能为空串）
   */
  function onPat(state, todayKey, now, lastLine) {
    var next = rollDay(state, todayKey);
    var beforeLevel = levelOf(next.affection);
    var gained = 0;
    var line = '';
    var capped = false;
    if (next.patsToday < RULES.patDailyCap) {
      next.patsToday += 1;
      gained = RULES.patAffection;
      next.affection = clamp(next.affection + gained, 0, RULES.max);
    } else {
      capped = true;
    }
    next.totalPats += 1;                                  // 成就统计：每次摸头都算（每日上限只锁好感入账）
    var hour = new Date(now || Date.now()).getHours();    // 凌晨与否看本地钟（dayKey 没有时刻字段）
    if (hour >= 0 && hour < 5) next.nightPats += 1;       // 夜猫子搭档
    touchDay(next, todayKey);
    var afterLevel = levelOf(next.affection);
    bumpPeak(next);
    if (afterLevel > beforeLevel) {
      line = (LEVELS[afterLevel] || {}).line || '';
    } else {
      // 到顶那句**优先于**摸头台词池：好感条没动是唯一会被读成"她坏了"的表现，
      // 而池子里任何一句（"再摸一下也可以哦"）都在暗示还有奖励。
      var lines = capped ? PAT_CAP_LINES
        : (PAT_LINES[Math.min(afterLevel, PAT_LINES.length - 1)] || []);
      line = pickFrom(lines, null, lastLine);
    }
    return { state: next, gained: gained, capped: capped,
      leveledUp: afterLevel > beforeLevel, level: afterLevel, line: line };
  }

  /**
   * 把统计到的刷课时长折算成好感度。
   *
   * 水位（countedSeconds）只按**实际转化为分数的秒数**推进 —— 今天被每日上限挡住的部分
   * 还在水位之后，今天之内接着算；**跨天不补**（统计层每天把 activeSeconds 归零，
   * 昨天那些秒数已经读不回来了），所以上限要放在"正常刷一晚课就能拿满"的位置。
   * @param {Object|number} study 统计层那一格 `{date, activeSeconds}`（推荐 —— 跨天的
   *        陈旧统计会被挡掉），或直接给 activeSeconds 数字
   * @returns {{state, gained, leveledUp, level}}
   */
  function applyStudySeconds(state, study, todayKey) {
    var next = rollDay(state, todayKey);
    var s = (study && typeof study === 'object') ? study : { activeSeconds: study };
    var statDay = String(s.date || s.day || '');
    // 统计层落盘是节流的（攒够 20 秒才写一次），跨天时**昨天那一格会多活一小段**。
    // 水位刚跟着归零，这一拍不挡就等于把昨天的时长在新的一天里再折一次 —— 半夜白送一天上限。
    if (statDay && statDay !== todayKey) {
      return { state: next, gained: 0, leveledUp: false, level: levelOf(next.affection) };
    }
    var beforeLevel = levelOf(next.affection);
    var perPointSeconds = RULES.studyMinutesPerPoint * 60;
    var active = Number(s.activeSeconds) || 0;
    // 水位比表还高，只可能是**旧语义**留下的那一格：新语义下 counted 只跟着 pending 走，
    // 永远追不过 activeSeconds。上面那道跨天归零要等零点才生效，而 2026-11-15 16:00
    // 现场实测 countedSeconds 32400 撞上当天 activeSeconds 12840 —— 人已经刷了 3 小时 28 分，
    // studyPointsToday 还是 0（摸头那天加了 6）。不当场捡回来，用户今晚看到的仍是"刷课一分不涨"。
    if (next.countedSeconds > active) next.countedSeconds = 0;
    var pending = Math.max(0, active - next.countedSeconds);
    var earnable = Math.floor(pending / perPointSeconds);
    var room = RULES.studyPointsDailyCap - next.studyPointsToday;
    var allowed = Math.max(0, Math.min(earnable, room));
    next.countedSeconds += allowed * perPointSeconds;
    next.studyPointsToday += allowed;
    next.affection = clamp(next.affection + allowed, 0, RULES.max);
    if (allowed > 0) {
      next.totalStudyMinutes += allowed * RULES.studyMinutesPerPoint;   // 成就统计：只记实际入账的分钟
      touchDay(next, todayKey);
    }
    var afterLevel = levelOf(next.affection);
    bumpPeak(next);
    return { state: next, gained: allowed, leveledUp: afterLevel > beforeLevel, level: afterLevel };
  };

  // ── 记忆翻牌（D 阶段）：发牌与记成绩，全是纯函数 ────────────────────────
  // 卡面用她的**表情池**（FACES）—— 以吉祥物为主角的意思就是牌是她自己的脸。
  // 随机源可注入（测试要确定性；界面传 undefined 走 Math.random）。

  /** 洗牌（Fisher-Yates；rnd 可注入） */
  function shuffleInto(list, rnd) {
    var pick = typeof rnd === 'function' ? rnd : Math.random;
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(pick() * (i + 1));
      // ⚠️ 闸要写成 !(j>=0 && j<len)：NaN 与「<0」「>=len」两个比较全是 false，
      // 写成 j<0||j>=len 时 NaN 会漏过去，swap 就把 undefined 混进牌堆（规则套件实测抓到）。
      if (!(j >= 0 && j < list.length)) j = 0;   // 烂 rnd（越界/恒 NaN）退化为 j=0，别抛异常
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  /** 发一局牌：从 FACES 挑 memoryPairs 张**互不相同**的脸，各复制一份再洗匀。
   *  @returns {string[]} 长度 = memoryPairs × 2 的文件名数组，每张恰好出现两次 */
  function dealMemoryDeck(rnd) {
    var pool = FACES.slice();
    shuffleInto(pool, rnd);
    var faces = pool.slice(0, Math.min(RULES.memoryPairs, pool.length));
    var deck = faces.concat(faces);
    return shuffleInto(deck, rnd);
  }

  /**
   * 记一局胜利。
   * @returns {{state, gained, leveledUp, level, bestMoves, firstToday}}
   *   gained = 今天首胜才有 RULES.gameDailyReward（第二局起纯玩）；
   *   bestMoves = 这一局是不是**新纪录**（步数更少算更好；同步数比秒）。
   *   ⚠️ 好感已满时首胜照样记这一天（gained 照常返回，只是入账被 clamp 到上限）——
   *   与摸头的既有口径一致，不开"留着以后领"的特殊格。
   */
  function recordMemoryWin(state, todayKey, moves, seconds) {
    var next = rollDay(state, todayKey);
    var mv = Math.max(1, Math.floor(Number(moves) || 0) || 1);
    var sec = Math.max(0, Math.floor(Number(seconds) || 0));
    var beforeLevel = levelOf(next.affection);
    var gained = 0;
    var firstToday = next.memoryRewardDay !== todayKey;
    if (firstToday) {
      next.memoryRewardDay = todayKey;
      gained = RULES.gameDailyReward;
      next.affection = clamp(next.affection + gained, 0, RULES.max);
    }
    next.memoryWins += 1;
    var better = next.memoryBestMoves === 0 ||
      mv < next.memoryBestMoves ||
      (mv === next.memoryBestMoves && sec > 0 && sec < (next.memoryBestSeconds || 0));
    if (better) { next.memoryBestMoves = mv; next.memoryBestSeconds = sec; }
    touchDay(next, todayKey);
    bumpPeak(next);
    var afterLevel = levelOf(next.affection);
    return { state: next, gained: gained, leveledUp: afterLevel > beforeLevel, level: afterLevel,
      bestMoves: better, firstToday: firstToday };
  }

  return {
    RULES: RULES,
    LEVELS: LEVELS,
    BOND_VERSION: BOND_VERSION,
    PAST_SCALES: PAST_SCALES,
    PAT_LINES: PAT_LINES,
    PAT_CAP_LINES: PAT_CAP_LINES,
    IDLE_LINES: IDLE_LINES,
    PERIODS: PERIODS,
    SAY: SAY,
    periodOf: periodOf,
    pickLine: pickLine,
    bandOf: bandOf,
    pickIdleLine: pickIdleLine,
    ART: ART,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dayKeyOf: dayKeyOf,
    prevDayKeyOf: prevDayKeyOf,
    seasonOf: seasonOf,
    levelOf: levelOf,
    displayLevelOf: displayLevelOf,
    migrateBond: migrateBond,
    rollDay: rollDay,
    touchDay: touchDay,
    evaluateAchievements: evaluateAchievements,
    markAchievements: markAchievements,
    achHint: achHint,
    onPat: onPat,
    applyStudySeconds: applyStudySeconds,
    dealMemoryDeck: dealMemoryDeck,
    recordMemoryWin: recordMemoryWin
  };
});
