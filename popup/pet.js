// ── 四季主题 / 点击水纹 / 彩蛋小人 ──────────────────────────────────────────
//
// 纯取乐，与刷课逻辑**零耦合**：不读配置、不写存储、不碰 page.js。
// 外层包 try/catch —— 任何一步出错都静默放弃，绝不能让装饰拖垮弹窗。
// 四季是**每次打开重掷**，刻意不做持久化（用户要的就是"每次都不同"）。
(function omFancy() {
  try {
    // 精简模式下整套角色逻辑不启动 —— 不是"藏起来"，是**真不跑**
    if (document.documentElement.getAttribute("data-ui") !== "fancy" && !document.body.classList.contains("im")) return;
    var timeoutHandles = new Set(), intervalHandles = new Set();
    function setTimeout(fn, ms) {
      var id = window.setTimeout(function () { timeoutHandles.delete(id); fn(); }, ms);
      timeoutHandles.add(id);
      return id;
    }
    function setInterval(fn, ms) {
      var id = window.setInterval(fn, ms);
      intervalHandles.add(id);
      return id;
    }
    var SEASONS = ["spring", "summer", "autumn", "winter"];
    var season = SEASONS[Math.floor(Math.random() * SEASONS.length)];
    document.documentElement.setAttribute("data-season", season);

    function isEcoMotion() {
      try {
        if (document.documentElement.getAttribute("data-motion") === "eco") return true;
        return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      } catch (e) { return false; }
    }
    if (isEcoMotion()) document.documentElement.setAttribute("data-motion", "eco");
    window.__omitoneSeason = season;

    function kick(el, frames, opts) {
      if (isEcoMotion()) { try { el.remove(); } catch (e) {} return; }
      try {
        var a = el.animate(frames, opts);
        a.onfinish = function () { try { el.remove(); } catch (e) {} };
      } catch (e) { try { el.remove(); } catch (e2) {} }
    }

    // ---- 常驻粒子：纯 CSS 循环，数量固定，不进 rAF ----
    var layer = document.getElementById("fxLayer");
    if (layer) {
      var count = isEcoMotion() ? 5 : 10;
      for (var i = 0; i < count; i++) {
        var p = document.createElement("i");
        var size = 3 + Math.random() * 4;
        p.style.width = size + "px";
        p.style.height = size + "px";
        p.style.left = (Math.random() * 96) + "%";
        p.style.animationDuration = (6 + Math.random() * 5) + "s";
        p.style.animationDelay = (-Math.random() * 8) + "s";
        p.style.opacity = (0.32 + Math.random() * 0.38).toFixed(2);
        if (season === "autumn") p.style.borderRadius = "40% 60% 55% 45%";
        if (season === "winter") p.style.background = "rgba(255,255,255,.88)";
        layer.appendChild(p);
      }
    }

    // ---- 点击：水纹扩散 + 季节粒子炸开 ----
    function burst(x, y, small) {
      if (isEcoMotion()) return;
      var ring = document.createElement("span");
      ring.className = "fx-ripple";
      ring.style.left = x + "px";
      ring.style.top = y + "px";
      document.body.appendChild(ring);
      kick(ring, [{ transform: "scale(.4)", opacity: .85 }, { transform: "scale(6.5)", opacity: 0 }],
        { duration: 520, easing: "cubic-bezier(.22,1,.36,1)" });

      var n = small ? 5 : 8;
      for (var k = 0; k < n; k++) {
        var s = document.createElement("span");
        s.className = "fx-spark";
        s.style.left = x + "px";
        s.style.top = y + "px";
        document.body.appendChild(s);
        var angle = (Math.PI * 2 * k) / n + Math.random() * 0.5;
        var dist = 18 + Math.random() * 16;
        kick(s, [
          { transform: "translate(0,0) scale(1)", opacity: .9 },
          { transform: "translate(" + Math.cos(angle) * dist + "px," + (Math.sin(angle) * dist + 10) + "px) scale(.3)", opacity: 0 }
        ], { duration: 700, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    }

    /**
     * 摸头：冒三颗小心心。
     * 用字符画而不是素材 —— 39 张立绘里没有"爱心"，临时加一张图反而破坏风格统一。
     */
    function heartBurst(x, y) {
      if (isEcoMotion()) return;
      for (var i = 0; i < 3; i++) {
        var h = document.createElement("span");
        h.className = "fx-heart";
        h.textContent = "♥";
        h.style.left = (x + (Math.random() - 0.5) * 14) + "px";
        h.style.top = (y - 3) + "px";
        document.body.appendChild(h);
        var dx = (Math.random() - 0.5) * 22;
        kick(h, [
          { transform: "translate(0,0) scale(.5)", opacity: 0 },
          { transform: "translate(" + dx.toFixed(0) + "px,-9px) scale(1)", opacity: 1, offset: .28 },
          { transform: "translate(" + (dx * 1.7).toFixed(0) + "px,-28px) scale(.75)", opacity: 0 }
        ], { duration: 880 + i * 130, easing: "cubic-bezier(.3,1.2,.6,1)" });
      }
    }

    var snowClicks = 0;
    var petReact = function () {};   // 由小人那段接管：点完按钮让它开心一下

    /** 冬天的"积雪整体塌落"：一整块雪从按钮顶面掉下去（不是碎末） */
    function snowSlab(btn) {
      if (isEcoMotion()) return;
      var r = btn.getBoundingClientRect();
      var slab = document.createElement("span");
      slab.className = "fx-snow";
      slab.style.left = (r.left + r.width / 2 - 15) + "px";
      slab.style.top = (r.top + 1) + "px";
      slab.style.width = "30px";
      slab.style.height = "6px";
      slab.style.borderRadius = "3px";
      document.body.appendChild(slab);
      kick(slab, [
        { transform: "translateY(0) rotate(0deg)", opacity: 1 },
        { transform: "translateY(26px) rotate(9deg)", opacity: 0 }
      ], { duration: 520, easing: "cubic-bezier(.5,0,.75,1)" });
    }

    /** 冬天的"塌雪"：从按钮下沿掉一串雪，边掉边化 */
    function spillSnow(btn) {
      if (isEcoMotion()) return;
      var r = btn.getBoundingClientRect();
      for (var i = 0; i < 7; i++) {
        var f = document.createElement("span");
        f.className = "fx-snow";
        f.style.left = (r.left + 10 + Math.random() * (r.width - 20)) + "px";
        f.style.top = (r.bottom - 2) + "px";
        document.body.appendChild(f);
        kick(f, [
          { transform: "translate(0,0) scale(1)", opacity: 1 },
          { transform: "translate(" + ((Math.random() - 0.5) * 26).toFixed(0) + "px," + (18 + Math.random() * 22).toFixed(0) + "px) scale(.45)", opacity: 0 }
        ], { duration: 700 + Math.random() * 500, easing: "cubic-bezier(.4,0,.7,1)" });
      }
    }

    /** 秋天：脚下踩出三片叶子 */
    function stepLeaves() {
      if (isEcoMotion()) return;
      var m = document.getElementById("mascot");
      if (!m) return;
      var r = m.getBoundingClientRect();
      for (var i = 0; i < 3; i++) {
        var l = document.createElement("span");
        l.className = "fx-leaf";
        l.style.left = (r.left + 6 + Math.random() * 22) + "px";
        l.style.top = (r.bottom - 6) + "px";
        document.body.appendChild(l);
        kick(l, [
          { transform: "translate(0,-14px) rotate(0deg)", opacity: 0 },
          { transform: "translate(0,0) rotate(40deg)", opacity: .9, offset: .4 },
          { transform: "translate(6px,10px) rotate(90deg)", opacity: 0 }
        ], { duration: 900, easing: "ease-out" });
      }
    }
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var hit = t.closest(".btn, .minor button, .toggle, .link-btn");
      if (!hit) return;
      var box = hit.getBoundingClientRect();
      burst(ev.clientX || (box.left + box.width / 2), ev.clientY || (box.top + box.height / 2),
        !!t.closest(".toggle, .link-btn"));

      // 四个季节，四种"点下去之后发生什么"
      if (!hit.classList.contains("btn")) return;
      try { petReact(); } catch (e) {}

      if (season === "winter") {
        snowClicks += 1;
        hit.classList.add("snow-hit");
        snowSlab(hit);      // 整块积雪骤然塌落
        spillSnow(hit);     // 再溅一把碎雪
        var m0 = document.getElementById("mascot");
        var b0 = document.getElementById("mascotBubble");
        if (m0) {
          m0.setAttribute("data-snow", String(Math.min(3, snowClicks)));
          if (snowClicks >= 3) {
            m0.setAttribute("data-pose", "happy");
            say("雪人堆好啦！", 2600);
          }
        }
      } else if (season === "summer") {
        hit.classList.add("sunbaked");
        var m1 = document.getElementById("mascot");
        if (m1) {
          m1.setAttribute("data-eat", "1");
          setTimeout(function () { m1.removeAttribute("data-eat"); }, 1300);
        }
      } else if (season === "autumn") {
        stepLeaves();
      }
    }, true);

    // ---- 彩蛋小人：滑下来挂边 → 挣扎攀爬 → 坐到更新栏旁 ----
    var mascot = document.getElementById("mascot");
    var bubble = document.getElementById("mascotBubble");
    if (!mascot) return;

    function pose(name) { mascot.setAttribute("data-pose", name); }

    // ── 动作序列令牌 ──────────────────────────────────────────────────
    // 同一时刻只能有一个"导演"：出场彩蛋、点击彩蛋、闲置轮换会互相抢姿势。
    // 没有令牌时，出场彩蛋的 9.5 秒定时器会把正在爬行的人一把按成"坐"，
    // 看起来就是"乱动"或"不动"。新序列一开，旧序列的定时器全部作废。
    var petSeq = 0, petBusyUntil = 0, poseTimer = null;
    function newSeq(busyMs, freezeTravel) {
      clearTimeout(poseTimer);
      poseTimer = null;
      var t = ++petSeq;
      petBusyUntil = busyMs ? Date.now() + busyMs : Date.now();
      mascot._busyUntil = petBusyUntil;
      // 读独立 translate 而非缩放后的矩形，沉浸式窗口也能停在原地。
      if (freezeTravel) {
        var travel = getComputedStyle(mascot).translate;
        mascot.style.transition = "";
        mascot.style.transform = "";
        mascot.classList.add("show");
        if (travel && travel !== "none") mascot.style.translate = travel;
        mascot.classList.remove("yawn");
        mascot.removeAttribute("data-eat");
        var art = mascot.querySelector(".pet-art");
        if (art && art.getAnimations) art.getAnimations().forEach(function (a) { a.cancel(); });
      }
      return t;
    }
    function alive(t) { return t === petSeq; }

    // ── 出场：常规"淡入落座"；**1% 概率**才走"吊边 → 攀爬 → 落座"的彩蛋 ──
    // 每次打开独立重掷、不记忆 —— "再开一次"就是重新抽一次。
    var EASTER_RATE = 0.01;
    // ?egg=1 可以手动看一次彩蛋（调试/预览用），不影响 1% 的随机
    var isEgg = new URLSearchParams(location.search).get("egg") === "1" || Math.random() < EASTER_RATE;
    window.__omitoneEgg = isEgg;

    function setPose(name, holdMs, token) {
      var t = token || newSeq((holdMs || 0) + 250, true);
      if (!alive(t)) return t;
      // 同名按钮和共用关键帧的动作（jump / surprise）都必须从头播。
      mascot.removeAttribute("data-pose");
      void mascot.offsetWidth;
      var nearTop = mascot.getBoundingClientRect().top < 16;
      if (nearTop) mascot.setAttribute("data-glyph-side", "1");
      else mascot.removeAttribute("data-glyph-side");
      pose(name);
      clearTimeout(poseTimer);
      poseTimer = null;
      if (holdMs) {
        poseTimer = setTimeout(function () {
          if (alive(t)) pose("sit");
        }, holdMs);
      }
      return t;
    }
    petReact = function () { setPose("happy", 1200); };   // 点按钮 → 开心 1.2 秒 → 回坐姿

    // 帧率治理器可能在初始化之后才降档，正在播放的 WAAPI 也必须收尾。
    function settleEcoMotion() {
      if (!isEcoMotion()) return;
      setPose("sit");
      mascot.classList.add("show");
      if (mascot.getAnimations) {
        mascot.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); });
      }
      document.querySelectorAll(".fx-ripple, .fx-spark, .fx-heart, .fx-snow, .fx-leaf").forEach(function (el) { el.remove(); });
    }
    var motionObserver = new MutationObserver(settleEcoMotion);
    motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    try {
      var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      motionQuery.addEventListener("change", function () {
        if (motionQuery.matches) document.documentElement.setAttribute("data-motion", "eco");
      });
    } catch (e) {}

    if (isEgg && !isEcoMotion()) {
      var eggSeq = newSeq(11000, false);
      setTimeout(function () {                        // 1.4s：被发现挂在边缘
        if (!alive(eggSeq)) return;
        mascot.classList.add("show");
        mascot.style.transform = "translateY(-96px)";
        pose("hang");
      }, 1400);
      setTimeout(function () {                        // 3.0s：挣扎着往下爬
        if (!alive(eggSeq)) return;
        mascot.style.transform = "translateY(-58px)";
        pose("climb");
      }, 3000);
      setTimeout(function () {                        // 4.2s：落座
        if (!alive(eggSeq)) return;
        mascot.style.transform = "";
        pose("sit");
      }, 4200);
      setTimeout(function () {                        // 5.2s：指着更新栏
        if (!alive(eggSeq)) return;
        pose("point");
        say(isUpdateMuted() ? "今天也要好好学习" : "要检查更新吗？", 4300);
      }, 5200);
      setTimeout(function () {                        // 9.5s：收尾
        if (!alive(eggSeq)) return;
        pose("happy");
        mascot.classList.add("show");            // 彩蛋收尾必须回到可见状态
        mascot.style.transform = "";
      }, 9500);
    } else {
      // 精美模式下 0.8 秒淡入。之前"默认不出现"是为了彩蛋的意外感，
      // 但结果是工具条和彩蛋都够不着 —— 可用性优先，改成默认现身。
      var entrySeq = newSeq(1050, false);
      setTimeout(function () {
        mascot.classList.add("show");
        if (alive(entrySeq)) setPose("sit", 0, entrySeq);
      }, 800);
    }

    // 深夜彩蛋：23:00–05:00 打开才说一句，且 6 小时内只打一次招呼。
    // 白天永远不触发 —— 不制造"她怎么老在说话"的噪音。
    try {
      var hr = new Date().getHours();
      var NIGHT_KEY = "omitone.pet.night";
      var lastNight = Number(localStorage.getItem(NIGHT_KEY) || 0);
      if ((hr >= 23 || hr < 5) && Date.now() - lastNight > 6 * 3600 * 1000) {
        setTimeout(function () {
          try {
            if (!mascot.classList.contains("show") || bookOpen || dragging || Date.now() < petBusyUntil) return;
            localStorage.setItem(NIGHT_KEY, String(Date.now()));
            setPose("sad", 2600);
            say("这么晚还没睡…别熬太久", 2800);
          } catch (e) {}
        }, isEgg ? 10000 : 1400);   // 彩蛋在演的时候晚点说，别抢台词
      }
    } catch (e) {}

    // 通用触发：悬停「检测更新」→ 指过去 1.8 秒
    var updLink = document.getElementById("checkUpdate");
    if (updLink) updLink.addEventListener("mouseenter", function () { setPose("point", 1800); });

    // ── 悬停工具条 / 双击收起 / 换装 ──────────────────────────────────────
    var OUT_KEY = "omitone.pet.outfit";
    var HIDE_KEY = "omitone.pet.hidden";
    // 「装」只走服装 —— 表情和动作是另一回事，混在一起用户会看不出规律
    var SKINS = ["pet.png",
      "pet-1.png", "pet-2.png", "pet-3.png", "pet-4.png",
      "pet-5.png", "pet-6.png", "pet-7.png", "pet-8.png",
      "pet-9.png", "pet-10.png",
      "pet-11.png", "pet-12.png", "pet-13.png", "pet-14.png",
      "pet-15.png", "pet-16.png"];   // 17 套服装
    // 「表」走表情 + 动作（都是默认装束下的另一张脸/另一个动作）
    var FACES = ["pet-e1.png", "pet-e2.png", "pet-e3.png", "pet-e4.png",
                 "pet-e5.png", "pet-e6.png",
                 "pet-i5.png", "pet-i6.png", "pet-i7.png", "pet-i8.png",
                 "pet-e11.png", "pet-e12.png"];   // 12 张表情
    var POSES = ["pet.png", "pet-i1.png", "pet-i2.png", "pet-i3.png", "pet-i4.png",
                 "pet-e7.png", "pet-e8.png", "pet-e9.png", "pet-e10.png",
                 "pet-i9.png", "pet-i10.png"];  // 11 个姿势
    // 动作库：不占素材，全是 CSS 形变（+ 一个头顶字符）。第三个值 = 停留时长。
    var ANIMS = [
      ["spin", "转圈", 950], ["jump", "蹦一下", 760], ["shake", "摇头", 1000],
      ["bow", "鞠个躬", 1000], ["peek", "探头", 1150], ["dizzy", "晕乎", 1400],
      ["sleep", "打盹", 2300], ["cheer", "欢呼", 1200], ["surprise", "吓一跳", 700],
      ["think", "思考", 2000], ["sing", "哼歌", 1900]
    ];
    var OUTFITS = SKINS.length;
    var immersive = document.body.classList.contains("im");
    var POS_KEY = immersive ? "omitone.pet.pos.im" : "omitone.pet.pos";
    function clampPosition(x, y) {
      var w = mascot.offsetWidth || (immersive ? 150 : 40);
      var h = mascot.offsetHeight || (immersive ? 210 : 56);
      // 工具条向左伸出、位于人物底部，也必须留在视口里。
      var minX = immersive ? 2 : Math.max(2, 88 - w);
      var maxX = Math.max(minX, window.innerWidth - w - 12);
      var maxY = Math.max(2, window.innerHeight - h - 24);
      return { x: Math.round(Math.max(minX, Math.min(maxX, x))), y: Math.round(Math.max(2, Math.min(maxY, y))) };
    }
    function putPosition(x, y) {
      var p = clampPosition(x, y);
      mascot.style.translate = p.x + "px " + p.y + "px";
      return p;
    }
    function homePosition() {
      return immersive ? { x: (window.innerWidth - 150) / 2, y: (window.innerHeight - 210) / 2 } : { x: window.innerWidth - 56, y: 2 };
    }
    var FACE_KEY = "omitone.pet.face";
    var faceIdx = -1;
    /** 换动作时的过渡：先缩一下、再弹回、带一点侧倾 —— 让"换图"看起来像"动了一下" */
    function playMotion(el) {
      if (isEcoMotion()) return;
      try {
        el.animate([
          { transform: "scale(1) rotate(0deg)" },
          { transform: "scale(.92) rotate(-4deg)", offset: .35 },
          { transform: "scale(1.06) rotate(3deg)", offset: .72 },
          { transform: "scale(1) rotate(0deg)" }
        ], { duration: 460, easing: "cubic-bezier(.34,1.5,.64,1)" });
      } catch (e) {}
    }
    var poseIdx = 0;
    // 上次把她拖到哪儿了？就放回哪儿
    try {
      var savedPos = localStorage.getItem(POS_KEY);
      var home = homePosition();
      var xy = savedPos ? savedPos.split(",") : [String(home.x), String(home.y)];
      var px = Number(xy[0]), py = Number(xy[1]);
      if (xy.length === 2 && Number.isFinite(px) && Number.isFinite(py)) putPosition(px, py);
      else putPosition(home.x, home.y);
    } catch (e) {}
    window.addEventListener("resize", function () {
      var r = mascot.getBoundingClientRect();
      putPosition(r.left, r.top);
    });
    var outfitIdx = 0;
    var LOCK_KEY = "omitone.pet.manualUntil";
    var outfitLockUntil = 0;
    try { outfitLockUntil = Number(localStorage.getItem(LOCK_KEY) || 0) || 0; } catch (e) {}
    function lockManualOutfit() {
      outfitLockUntil = Date.now() + 10 * 60 * 1000;
      try { localStorage.setItem(LOCK_KEY, String(outfitLockUntil)); } catch (e) {}
    }
    function applyOutfit(i) {
      outfitIdx = ((i % OUTFITS) + OUTFITS) % OUTFITS;
      if (outfitIdx) mascot.setAttribute("data-outfit", String(outfitIdx));
      else mascot.removeAttribute("data-outfit");
      // 真的换图 —— 之前只加了 hue-rotate，而情绪也会写 filter，两家抢同一个属性，
      // 谁后写谁生效 → 看着就是"点了没反应"。改用换 src，彻底不碰 filter。
      var art = mascot.querySelector(".pet-art");
      if (art) art.setAttribute("src", SKINS[outfitIdx] || SKINS[0]); playMotion(art);
      try {
        localStorage.setItem(OUT_KEY, String(outfitIdx));
        localStorage.setItem("omitone.pet.src", SKINS[outfitIdx] || SKINS[0]);
      } catch (e) {}
      return outfitIdx;
    }
    // 预载全部立绘，切换时不闪
    SKINS.forEach(function (f) { try { var im = new Image(); im.src = f; } catch (e) {} });

    // 立绘册里选的是**某一张图**，它不一定是"第几套衣服"。
    // 所以单独存一份 src，下次打开原样恢复 —— 否则选了表情、重开又变回服装。
    // ⚠️ 必须在 applyOutfit 之前读：它内部会把当前服装写进 SRC_KEY，
    //    读晚了拿到的是 pet.png，选过的样子等于白选。
    var SRC_KEY = "omitone.pet.src";
    var savedSrc = null;
    try { savedSrc = localStorage.getItem(SRC_KEY); } catch (e) {}

    try { outfitIdx = applyOutfit(Number(localStorage.getItem(OUT_KEY) || 0)); } catch (e) {}
    var allowedSources = SKINS.concat(FACES, POSES);
    if (savedSrc && allowedSources.indexOf(savedSrc) >= 0) {
      try {
        var art0 = mascot.querySelector(".pet-art");
        if (art0) art0.setAttribute("src", savedSrc);
        syncIndexFromSrc(savedSrc);
        localStorage.setItem(SRC_KEY, savedSrc);   // applyOutfit 刚刚覆盖过，写回来
      } catch (e) {}
    }

    // ── 立绘册 ──────────────────────────────────────────────────────────
    // 17 套衣服 / 12 表情 / 11 姿势，一共 39 张。按顺序点「装」找一套要按十几次，
    // 所以给一个能直接挑的网格；顺便当作已收集多少张的"图鉴"。
    var book = document.getElementById("petBook");
    var bookBody = document.getElementById("petBookBody");
    var bookMeta = document.getElementById("petBookMeta");
    var bookOpen = false;

    function markBook() {
      if (!bookBody) return;
      var a = mascot.querySelector(".pet-art");
      var cur = a ? a.getAttribute("src") : "";
      var cells = bookBody.querySelectorAll(".pet-book-cell");
      for (var i = 0; i < cells.length; i++) {
        cells[i].classList.toggle("on", cells[i].getAttribute("data-src") === cur);
      }
    }
    function buildBook() {
      if (!bookBody || bookBody.firstChild) return;
      var groups = [["服装", SKINS], ["表情", FACES], ["姿势", POSES]];
      var html = "", seen = {};
      groups.forEach(function (g) {
        // pet.png 既是"默认服装"也是"默认姿势"，同一张图只摆一次，免得张数对不上
        var list = g[1].filter(function (f) { if (seen[f]) return false; seen[f] = 1; return true; });
        if (!list.length) return;
        html += '<div class="pet-book-sep">' + g[0] + " · " + list.length + " 张</div>";
        list.forEach(function (f) {
          html += '<button type="button" class="pet-book-cell" data-src="' + f +
                  '" title="' + f.replace(/\.png$/, "") + '"><img src="' + f + '" alt="" draggable="false"></button>';
        });
      });
      // 动作组不是图，所以排一片文字按钮
      html += '<div class="pet-book-sep">动作 · ' + ANIMS.length + " 个</div>";
      ANIMS.forEach(function (a) {
        html += '<button type="button" class="pet-book-anim" data-anim="' + a[0] + '">' + a[1] + "</button>";
      });
      html += '<button type="button" class="pet-book-anim" data-anim="random">随机动作</button>';
      bookBody.innerHTML = html;
      if (bookMeta) {
        // pet.png 同时算服装和姿势，按去重后的张数报，别把同一张图标成两张
        var uniq = {};
        SKINS.concat(FACES, POSES).forEach(function (f) { uniq[f] = 1; });
        bookMeta.textContent = Object.keys(uniq).length + " 张立绘";
      }
    }
    function openBook() {
      if (!book) return;
      setPose("sit");   // 打开面板也是明确的用户操作，旧彩蛋/闲置动作立即让位
      mascot._bookOpen = true;
      buildBook();
      book.classList.add("show");
      book.setAttribute("aria-hidden", "false");
      bookOpen = true;
      markBook();
    }
    function closeBook() {
      if (!book || !bookOpen) return;
      book.classList.remove("show");
      book.setAttribute("aria-hidden", "true");
      bookOpen = false;
      mascot._bookOpen = false;
    }
    /** 选了某张图之后，把三个"顺序切换"的索引也拨到对应位置，
     *  否则下次按「装」会从旧索引继续，看起来像跳回去了。 */
    function syncIndexFromSrc(src) {
      var i;
      if ((i = SKINS.indexOf(src)) >= 0) { outfitIdx = i; try { localStorage.setItem(OUT_KEY, String(i)); } catch (e) {} }
      else if ((i = FACES.indexOf(src)) >= 0) { faceIdx = i; try { localStorage.setItem(FACE_KEY, String(i)); } catch (e) {} }
      else if ((i = POSES.indexOf(src)) >= 0) { poseIdx = i; }
    }

    // 上次按了"藏"就一直藏着，直到在弹窗底部点「显示小人」
    try {
      if (localStorage.getItem(HIDE_KEY) === "1") mascot.style.display = "none";
    } catch (e) {}

    var tools = document.getElementById("petTools");
    if (tools) {
      tools.addEventListener("click", function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest("button[data-act]") : null;
        if (!b) return;
        ev.stopPropagation();
        ev.stopImmediatePropagation && ev.stopImmediatePropagation();
        var act = b.getAttribute("data-act");
        if (act === "book") {
          if (bookOpen) closeBook(); else openBook();
        } else if (act === "pose") {
          var poseSeq = newSeq(1450, true);
          // 姿势 = 换一张"动作立绘"，和表情分开
          poseIdx = (poseIdx + 1) % POSES.length;
          var pa = mascot.querySelector(".pet-art");
          if (pa) { pa.setAttribute("src", POSES[poseIdx]); playMotion(pa); }
          try { localStorage.setItem(SRC_KEY, POSES[poseIdx]); } catch (e) {}
          lockManualOutfit();
          setPose("sit", 1200, poseSeq);
          addMood(2);
        } else if (act === "outfit") {
          setPose("sit", 450);
          applyOutfit(outfitIdx + (ev.shiftKey ? -1 : 1));
          lockManualOutfit();
          addMood(2);
        } else if (act === "face") {
          setPose("sit", 450);
          faceIdx = (faceIdx + 1) % FACES.length;
          var fa = mascot.querySelector(".pet-art");
          if (fa) { fa.setAttribute("src", FACES[faceIdx]); playMotion(fa); }
          try {
            localStorage.setItem("omitone.pet.face", String(faceIdx));
            localStorage.setItem(SRC_KEY, FACES[faceIdx]);
          } catch (e) {}
          lockManualOutfit();
          addMood(2);
        } else if (act === "hide") {
          newSeq(0, true);
          closeBook();
          try { localStorage.setItem(HIDE_KEY, "1"); } catch (e) {}
          mascot.style.display = "none";
        }
        if (bookOpen) markBook();   // 册开着的时候按「装/表/姿」，高亮跟着走
      });
    }

    // 双击：收成小头像 / 展开
    if (mascot) {
      mascot.addEventListener("dblclick", function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest("button")) return;
        ev.stopPropagation();
        ev.preventDefault();
        mascot.classList.toggle("collapsed");
      });
    }

    var lastRandomAnim = -1;
    function randomAnim() {
      var i = Math.floor(Math.random() * (lastRandomAnim < 0 ? ANIMS.length : ANIMS.length - 1));
      if (lastRandomAnim >= 0 && i >= lastRandomAnim) i += 1;
      lastRandomAnim = i;
      return ANIMS[i];
    }

    // ── 立绘册：点图直接换，点外面 / 按 Esc / 点 × 关上 ────────────────
    if (book) {
      book.addEventListener("click", function (ev) {
        var animBtn = ev.target && ev.target.closest ? ev.target.closest(".pet-book-anim") : null;
        if (animBtn) {
          ev.stopPropagation();
          var key = animBtn.getAttribute("data-anim");
          if (key === "random") key = randomAnim()[0];
          for (var i = 0; i < ANIMS.length; i++) {
            if (ANIMS[i][0] === key) {
              var animSeq = newSeq(ANIMS[i][2] + 250, true);
              setPose(ANIMS[i][0], ANIMS[i][2], animSeq);
              break;
            }
          }
          return;
        }
        var cell = ev.target && ev.target.closest ? ev.target.closest(".pet-book-cell") : null;
        if (!cell) return;
        ev.stopPropagation();
        setPose("happy", 700);
        var src = cell.getAttribute("data-src");
        var art = mascot.querySelector(".pet-art");
        if (art) { art.setAttribute("src", src); playMotion(art); }
        syncIndexFromSrc(src);
        try { localStorage.setItem(SRC_KEY, src); } catch (e) {}
        lockManualOutfit();   // 挑好的样子别被闲置轮换改掉，跨重开仍有效
        markBook();
        addMood(1);
      });
      var bookClose = document.getElementById("petBookClose");
      if (bookClose) {
        bookClose.addEventListener("click", function (ev) {
          ev.stopPropagation();
          closeBook();
        });
      }
      // 点面板外面关掉。工具条上的「册」要排除，否则会被判成"点外面"先关再开。
      document.addEventListener("mousedown", function (ev) {
        if (!bookOpen) return;
        if (book.contains(ev.target)) return;
        if (ev.target && ev.target.closest && ev.target.closest(".pet-tools")) return;
        closeBook();
      });
      document.addEventListener("keydown", function (ev) {
        if (bookOpen && (ev.key === "Escape" || ev.keyCode === 27)) closeBook();
      });
    }

    // 右键角色 = 打开立绘册（不占工具条位置，也不用记按钮在哪）
    mascot.addEventListener("contextmenu", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".pet-tools")) return;
      ev.preventDefault();
      openBook();
    });

    // ── 彩蛋动作：先定位 → 站到链接旁边 → 在**固定落脚点**做动作 ────────
    //
    // 坐标只有一套：`.pet` 是 position:fixed / left:0 / top:0，位移全写在
    // translate 上 —— 所以 translate 的数值就是**视口绝对坐标**，和
    // getBoundingClientRect() 完全同源，中间不需要任何换算。
    //
    // ⚠️ 这里原来有个真 bug：变量叫 lr0，下面却写 lr.right → ReferenceError，
    //    整段当场抛错，人停在原地一动不动（"出现了但不会动"就是它）。
    //    node --check 查不出这种错，只能靠真实浏览器跑一遍。
    function crawlToUpdate(expectedSeq) {
      var link = document.getElementById("checkUpdate");
      if (!link || !mascot || immersive || (expectedSeq && !alive(expectedSeq))) return;
      if (isEcoMotion()) { setPose("point", 1200); return; }
      var home = mascot.style.translate || ((window.innerWidth - 56) + "px 2px");
      var my = expectedSeq || newSeq(16000, false);   // 这一套动作独占舞台
      if (expectedSeq) {
        petBusyUntil = Date.now() + 16000;
        mascot._busyUntil = petBusyUntil;
      }

      /** 每次现量：窗口大小/滚动变了，也还是贴在链接旁边，不会站错地方 */
      function target() {
        var r = link.getBoundingClientRect();
        var pw = mascot.offsetWidth || 40;
        var ph = mascot.offsetHeight || 56;
        var pad = 6;
        var x, y;
        if (r.left - pw - pad >= 2) {             // 优先站左边（她从右边过来，不挡字）
          x = r.left - pw - pad;
          y = r.top + (r.height - ph) / 2;
        } else if (r.top - ph - pad >= 2) {       // 左边没地方就站上方
          x = r.left;
          y = r.top - ph - pad;
        } else {                                   // 再不行就压到右下角
          x = r.left + 2;
          y = r.bottom + 2;
        }
        return clampPosition(x, y);
      }

      // ① 蹲下 → ② 挥手：都只改姿态、**不换图**，所以人物不会"变个人"
      setPose("crouch", 0, my);
      setTimeout(function () {
        if (!alive(my)) return;
        setPose("wave", 0, my);
      }, 780);

      // ③ 爬过去：3.2 秒补间，落到刚才量好的固定点
      setTimeout(function () {
        if (!alive(my)) return;
        var p = target();                          // 出发前再量一次，防中途布局变动
        setPose("crawl", 0, my);
        mascot.style.transition = "translate 3.2s cubic-bezier(.4,0,.2,1)";
        mascot.style.translate = p.x + "px " + p.y + "px";

        // ④ 到位：指着它、连拍三下
        setTimeout(function () {
          if (!alive(my)) return;
          mascot.style.transition = "";
          setPose("point", 6000, my);
          patLink(link, 3, my);

          // ⑤ 收尾：没被人拖走的话，自己爬回原来的位置
          setTimeout(function () {
            if (!alive(my)) return;
            if (mascot.style.translate !== p.x + "px " + p.y + "px") return;  // 用户拖走了就别抢
            setPose("crawl", 0, my);
            mascot.style.transition = "translate 1.6s cubic-bezier(.4,0,.2,1)";
            mascot.style.translate = home;
            setTimeout(function () {
              if (!alive(my)) return;
              mascot.style.transition = "";
              setPose("sit", 0, my);
            }, 1700);
          }, 9000);
        }, 3300);
      }, 1500);
    }

    /**
     * 拍链接：拍的是**元素本身**，而且每一下都重新量一次它的位置 ——
     * 所以永远落在"检测更新"那几个字上，不会拍到旁边的空白。
     */
    function patLink(link, times, token) {
      var n = 0;
      var timer = setInterval(function () {
        if (!alive(token) || isEcoMotion()) { clearInterval(timer); return; }
        var r = link.getBoundingClientRect();
        var cx = r.left + r.width * 0.62;          // 手落在文字上（小人站在左边）
        var cy = r.top + r.height * 0.55;
        try { burst(cx, cy, true); } catch (e) {}
        try {
          link.animate([
            { transform: "scale(1)" },
            { transform: "scale(1.12)", offset: .45 },
            { transform: "scale(1)" }
          ], { duration: 320, easing: "ease-out" });
        } catch (e) {}
        if (++n >= times) clearInterval(timer);
      }, 900);
    }

    var stopped = false, idleLoopTimer = null, chatLoopTimer = null;
    function autonomousVisible() { return !stopped && !document.hidden && mascot.style.display !== "none"; }
    function stopAutonomous() {
      clearTimeout(idleLoopTimer); idleLoopTimer = null;
      clearTimeout(chatLoopTimer); chatLoopTimer = null;
      clearTimeout(moodPendingTimer); moodPendingTimer = null;
      clearTimeout(sayTimer); sayTimer = null;
      if (bubble) bubble.classList.remove("show");
      mascot.classList.add("is-paused");
    }
    function resumeAutonomous() {
      if (!autonomousVisible()) return;
      mascot.classList.remove("is-paused");
      idleLoop(); chatLoop();
      flushMood();
    }
    document.addEventListener("visibilitychange", function () {
      if (!autonomousVisible()) stopAutonomous(); else resumeAutonomous();
    });
    var hideObserver = new MutationObserver(function () {
      if (!autonomousVisible()) stopAutonomous(); else resumeAutonomous();
    });
    hideObserver.observe(mascot, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("pagehide", function () {
      stopped = true;
      newSeq(0, true);
      stopAutonomous();
      clearTimeout(poseTimer);
      motionObserver.disconnect(); hideObserver.disconnect();
      timeoutHandles.forEach(function (id) { window.clearTimeout(id); }); timeoutHandles.clear();
      intervalHandles.forEach(function (id) { window.clearInterval(id); }); intervalHandles.clear();
    });

    // ── 闲置自动轮换：没人理她时，自己换姿态、偶尔换身衣服 ──────────────
    // 12~25 秒一次，运行中（data-busy）不打扰。
    // 姿态**跟着心情走**：高兴就多蹦、低落就多蔫 —— 这是"情绪驱动立绘"的第一步。
    function idleLoop() {
      if (idleLoopTimer || !autonomousVisible()) return;
      var wait = 12000 + Math.random() * 13000;
      idleLoopTimer = setTimeout(function () {
        idleLoopTimer = null;
        if (!autonomousVisible()) return;
        try {
          var hidden = !mascot || mascot.style.display === "none" || !mascot.classList.contains("show");
          // 有序列在演（彩蛋爬行等）就让位，别去抢姿势
          if (!hidden && !bookOpen && !dragging && !mascot.getAttribute("data-busy") && Date.now() > petBusyUntil) {
            if (Math.random() < 0.45 && Date.now() > outfitLockUntil) applyOutfit(Math.floor(Math.random() * OUTFITS));
            if (Math.random() < 0.2) {
              var a = ANIMS[Math.floor(Math.random() * ANIMS.length)];
              setPose(a[0], a[2]);
            } else {
              var band = moodBand(getMood());
              var poses = band === "high" ? ["happy", "happy", "point"]
                        : band === "low" ? ["sad", "sit", "sad"]
                        : ["sit", "happy", "point"];
              setPose(poses[Math.floor(Math.random() * poses.length)], 2800);
            }
            if (bookOpen) markBook();
          }
        } catch (e) {}
        idleLoop();
      }, wait);
    }
    idleLoop();

    // 底部与沉浸式恢复入口共用恢复逻辑。
    var btnPetShow = document.getElementById("btnPetShow");
    var imRestore = document.getElementById("imRestorePet");
    if (imRestore) imRestore.addEventListener("click", function () {
      newSeq(0, true);
      mascot.classList.remove("collapsed");
      mascot.style.display = "block";
      mascot.classList.add("show");
      var home = homePosition(); putPosition(home.x, home.y);
      try { localStorage.removeItem(HIDE_KEY); localStorage.removeItem(POS_KEY); } catch (e) {}
      resumeAutonomous();
    });
    if (btnPetShow) {
      btnPetShow.addEventListener("click", function () {
        try { localStorage.removeItem(HIDE_KEY); } catch (e) {}
        var showSeq = newSeq(1200, true);
        mascot.style.display = "block";
        mascot.style.visibility = "visible";
        mascot.style.opacity = "1";
        var home = homePosition();
        putPosition(home.x, home.y);
        try { localStorage.removeItem(POS_KEY); } catch (e) {}
        mascot.classList.add("show");
        mascot.classList.remove("collapsed");
        setPose("happy", 900, showSeq);   // 0.9 秒后正好接上彩蛋第一拍（蹲下），不会被"回坐姿"打断
        try {
          var once = localStorage.getItem("omitone.pet.egged") !== "1";
          localStorage.setItem("omitone.pet.egged", "1");
          var t = once ? document.getElementById("toast") : null;
          if (!t) throw new Error("seen");
          if (t) {
            t.textContent = "恭喜触发彩蛋<(￣︶￣)↗ 请到最上面看看她";
            t.classList.add("prominent", "show");
            setTimeout(function () { t.classList.remove("prominent", "show"); }, 5200);
          }
        } catch (e) {}
        // ⚠️ 动作序列放在 try 外面：提示只弹一次，但**每次都要动**。
        // 之前它被包在 if(t) 里，第二次起 t 为 null → 永远不爬 → "人物出现了但不会动"。
        try { say("我在这儿～看上面", 2000); } catch (e) {}
        setTimeout(function () { crawlToUpdate(showSeq); }, 900);
      });
    }



    // ── 会说话：连戳躲避 / 自己嘟囔 / 按季节打招呼 ─────────────────────
    var SEASON_LINES = {
      spring: ["花开的时候，最适合刷课了", "今天也要一点点进步"],
      summer: ["记得喝水，别中暑", "冰激凌化了就不好吃了"],
      autumn: ["落叶踩起来咯吱响", "天凉了，记得加件外套"],
      winter: ["手好冷，但还想陪你", "雪停了再走也不迟"]
    };
    var sayTimer = null;
    function say(text, ms) {
      if (!bubble || document.hidden || mascot.style.display === "none" || stopped) return;
      bubble.textContent = text;
      bubble.classList.add("show");
      clearTimeout(sayTimer);
      sayTimer = setTimeout(function () { bubble.classList.remove("show"); }, ms || 2600);
    }

    // 连戳三次（2 秒内）→ 躲到旁边，并说一句；普通一下 = 摸头
    var POKES = ["别戳我啦", "在看书呢…", "再戳就跳走了", "好啦好啦，刷课要紧"];
    var pokeStamps = [], lastPat = 0, patCount = 0;
    if (mascot) {
      mascot.addEventListener("click", function (ev) {
        // 工具条上的操作不算"戳她"：任何祖先里带 pet-tools 的直接忽略
        if (ev.target && ev.target.closest && ev.target.closest(".pet-tools")) { ev.stopPropagation(); return; }
        if (suppressClick) { suppressClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
        var now = Date.now();
        pokeStamps.push(now);
        pokeStamps = pokeStamps.filter(function (t) { return now - t < 2000; });
        if (pokeStamps.length >= 3) {
          pokeStamps = [];
          // 躲一下：在**当前位置**上挪开 16px，0.9 秒后回来。
          // 以前这里写的是 translate=""，等于把人瞬移到左上角 —— 拖过之后特别明显。
          var dodgeSeq = setPose("shake", 1200);       // 正在爬的话就地取消
          var rc0 = mascot.getBoundingClientRect();
          var bx = Math.round(rc0.left), by = Math.round(rc0.top);
          mascot.classList.remove("dodge");
          if (!isEcoMotion()) {
            var dodgeHome = mascot.style.translate;
            mascot.style.transition = "translate .28s cubic-bezier(.34,1.4,.64,1)";
            mascot.style.translate = Math.max(2, bx - 16) + "px " + by + "px";
            setTimeout(function () {
              if (!alive(dodgeSeq)) return;
              mascot.style.translate = dodgeHome;
              setTimeout(function () { if (alive(dodgeSeq)) mascot.style.transition = ""; }, 320);
            }, 900);
          }
          say("别戳啦，我去旁边站会儿", 2200);
          addMood(-2);
        } else {
          // 摸头：冒心心 + 开心一下。心情 +1 有 4 秒冷却，免得连点直接刷满
          var rr = mascot.getBoundingClientRect();
          heartBurst(ev.clientX || (rr.left + rr.width / 2), ev.clientY || (rr.top + 8));
          setPose("happy", 800);
          if (now - lastPat > 4000) { lastPat = now; addMood(1); }
          // 每三次摸头说一句。原来这套台词在 omScene 里另有一个点击处理器，
          // 两边会互相抢姿态（一个要 happy、一个在 happy/sit 之间翻），已合并到这一处。
          if (++patCount % 3 === 0) {
            say(POKES[Math.floor(patCount / 3 - 1) % POKES.length], 2000);
          }
        }
      });
    }

    // 自己嘟囔：45~90 秒一次，正在忙（运行中）就不打扰
    var lines = SEASON_LINES[season] || SEASON_LINES.spring;
    function chatLoop() {
      if (chatLoopTimer || !autonomousVisible()) return;
      var wait = 45000 + Math.random() * 45000;
      chatLoopTimer = setTimeout(function () {
        chatLoopTimer = null;
        if (!autonomousVisible()) return;
        try {
          if (mascot && mascot.style.display !== "none" && !mascot.getAttribute("data-busy")) {
            say(lines[Math.floor(Math.random() * lines.length)], 3000);
          }
        } catch (e) {}
        chatLoop();
      }, wait);
    }
    chatLoop();



    // ── 情绪 / 拖拽 / 运行状态联动 ──────────────────────────────────────
    //
    // 三条都是**只读或纯本地**的：
    //   · 情绪存在 localStorage，不参与任何答题/调度逻辑；
    //   · 拖拽只改自己的 translate；
    //   · 运行状态是"单向只读"——角色接收 `omitone:run` 事件，绝不反向影响运行。
    // 任何一步出错都被外层 try/catch 吞掉，不会波及刷课。
    var MOOD_KEY = "omitone.pet.mood";
    function getMood() { try { return Number(localStorage.getItem(MOOD_KEY) || 50); } catch (e) { return 50; } }
    /** 三个档位。用档位而不是具体数值，是为了让"变脸"只在跨档时发生一次 */
    function moodBand(m) { return m >= 80 ? "high" : (m <= 15 ? "low" : "mid"); }
    var moodWas = "", moodPendingTimer = null, pendingMoodBand = "";
    function flushMood() { if (pendingMoodBand) moodReact(pendingMoodBand); }
    /** 跨档演出：忙时延后到当前动作结束，不抢动作，也不永久吞掉反馈。 */
    function moodReact(band) {
      try {
        clearTimeout(moodPendingTimer);
        if (!autonomousVisible() || bookOpen || dragging) { pendingMoodBand = band; return; }
        if (Date.now() < petBusyUntil) {
          pendingMoodBand = band;
          moodPendingTimer = setTimeout(function () {
            moodPendingTimer = null;
            if (moodBand(getMood()) === band) moodReact(band);
          }, petBusyUntil - Date.now() + 1);
          return;
        }
        pendingMoodBand = "";
        if (band === "high") { setPose("cheer", 1200); say("心情不错，想转个圈", 2400); }
        else if (band === "low") { setPose("sad", 4200); say("有点低落…陪我刷会儿课吧", 3000); }
        else { setPose("sit"); }
      } catch (e) {}
    }
    function applyMood(v) {
      if (!mascot) return;
      var m = Math.max(0, Math.min(100, v));
      try { localStorage.setItem(MOOD_KEY, String(m)); } catch (e) {}
      if (m >= 80) mascot.setAttribute("data-mood", "high");
      else if (m <= 15) mascot.setAttribute("data-mood", "low");
      else mascot.removeAttribute("data-mood");
      // 情绪条：宽度直接等于心情值，是后面"解锁成长"唯一要读的数字
      var bar = document.getElementById("petMood");
      if (bar) {
        if (bar.firstElementChild) bar.firstElementChild.style.width = m + "%";
        bar.setAttribute("title", "心情 " + Math.round(m) + " / 100");
      }
      // 只有**跨档**才演出；首次（moodWas 为空）只记档位 —— 刚打开不该被搭话
      var band = moodBand(m);
      if (band !== moodWas) {
        var had = moodWas;
        moodWas = band;
        if (had) moodReact(band);
      }
    }
    applyMood(getMood());

    function addMood(d) {
      var m = Math.max(0, Math.min(100, getMood() + d));
      applyMood(m);
      return m;
    }

    // 拖拽：按住就能拖着走，松手弹回去（不永久改变布局，免得下次打开位置乱了）
    var dragging = false, dragMoved = false, suppressClick = false;
    var startX = 0, startY = 0, moveX = 0, moveY = 0;
    // 记住按下前的位移：拖动按 delta 移动，取消时恢复原 translate
    var grabDX = 0, grabDY = 0, baseLeft = 0, baseTop = 0, originTranslate = "";
    if (mascot) {
      mascot.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        // ⚠️ 按在工具条上不算拖：pointer capture 会把后续 click 的目标改成 .pet，
        // 于是 closest(".pet-tools") 变 null，连点换装就被误判成"戳她"。
        if (ev.target && ev.target.closest && ev.target.closest(".pet-tools")) return;
        newSeq(1200, true);
        dragging = true;
        dragMoved = false;
        startX = ev.clientX; startY = ev.clientY; moveX = 0; moveY = 0;
        originTranslate = mascot.style.translate || getComputedStyle(mascot).translate || "";
        var rc = mascot.getBoundingClientRect();
        grabDX = ev.clientX - rc.left;      // 按在人物身上的哪个位置
        grabDY = ev.clientY - rc.top;
        baseLeft = rc.left;
        baseTop = rc.top;
        mascot.classList.add("dragging");
        try { mascot.setPointerCapture(ev.pointerId); } catch (e) {}
      });
      mascot.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        var dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!dragMoved && Math.sqrt(dx * dx + dy * dy) < 6) return;
        dragMoved = true;
        // 基于按下时的屏幕位置计算 delta，保留原有 translate，不跳回左上角。
        var p = putPosition(baseLeft + dx, baseTop + dy);
        moveX = p.x; moveY = p.y;
      });
      mascot.addEventListener("pointerup", function () {
        if (!dragging) return;
        dragging = false;
        mascot.classList.remove("dragging");
        suppressClick = dragMoved;
        if (dragMoved) {
          // 松手就停在这儿并记住 —— 用户要能把她挪到不挡事的地方
          try { localStorage.setItem(POS_KEY, Math.round(moveX) + "," + Math.round(moveY)); } catch (e) {}
          setPose("happy", 900); addMood(3);
        }
      });
      mascot.addEventListener("pointercancel", function () {
        dragging = false;
        dragMoved = false;
        suppressClick = false;
        mascot.classList.remove("dragging");
        mascot.style.translate = originTranslate;
      });
    }

    // 运行状态：跑起来时呼吸变快 + 说一句；停下来回到常态
    document.addEventListener("omitone:run", function (ev) {
      if (!mascot) return;
      if (ev.detail) {
        // 这一行不能省：闲置轮换 / 闲聊都靠 data-busy 让位，
        // CSS 里呼吸加快也是它；拆文件时漏掉，运行中照样会自己换装搭话。
        mascot.setAttribute("data-busy", "1");
        setPose("happy", 1600);
        say("开工啦，你忙你的", 2600);
      } else {
        mascot.removeAttribute("data-busy");
        say("收工，歇会儿吧", 2600);
      }
    });

  } catch (e) {}
})();



(function omPetSceneRole() {
  try {
    var imBack = document.getElementById("imBack");
    var imRestorePet = document.getElementById("imRestorePet");
    if (imBack) imBack.addEventListener("click", function () {
      location.href = chrome.runtime.getURL("popup/popup.html");
    });
    // 恢复角色由 omFancy 中的共享入口处理。
// 戳一戳：只在沉浸式窗口里可点（弹窗里保持 pointer-events:none，绝不挡操作）
var petEl = document.getElementById("mascot");
var petBubble = document.getElementById("mascotBubble");
var pokeIdx = 0;
var POKES = ["别戳我啦", "在看书呢…", "再戳就跳走了", "好啦好啦，刷课要紧"];
// ⚠️ 精美模式下点击统一由 omFancy 接管（摸头心心 / 连戳躲闪 / 三句一聊）。
// 两边都挂 click 的后果是互相抢姿态：一个要 happy，另一个在 happy/sit 之间翻，
// 看起来就是"点了表情不对"。这里只给**精简模式**兜底 —— 那套 omFancy 整段不启动。
if (petEl && document.documentElement.getAttribute("data-ui") !== "fancy" && !document.body.classList.contains("im")) {

  petEl.addEventListener("click", function (ev) {
    ev.stopPropagation();
    pokeIdx = (pokeIdx + 1) % POKES.length;
    petEl.setAttribute("data-pose", pokeIdx % 2 === 0 ? "happy" : "sit");
    if (petBubble) {
      petBubble.textContent = POKES[pokeIdx];
      petBubble.classList.add("show");
      clearTimeout(petEl._pokeTimer);
      petEl._pokeTimer = setTimeout(function () { petBubble.classList.remove("show"); }, 2200);
    }
  });
}

// 视线跟随（带死区 + 120ms 节流）：只有角度明显变了才动，
// 否则手抖一下它就疯狂转头 —— 那是"传感器"，不是"活的"。
if (petEl) {
  var lastAngle = 0;
  var gazeTick = null;
  document.addEventListener("mousemove", function (ev) {
    if (document.documentElement.getAttribute("data-motion") === "eco") return;
    if (gazeTick) return;
    gazeTick = setTimeout(function () { gazeTick = null; }, 120);
    var r = petEl.getBoundingClientRect();
    var ang = Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2));
    if (Math.abs(ang - lastAngle) < 0.35) return;      // 死区约 20°
    lastAngle = ang;
    var inner = petEl.querySelector(".pet-inner");
    if (inner) inner.style.translate = (Math.cos(ang) * 1.6).toFixed(1) + "px " + (Math.sin(ang) * 1.2).toFixed(1) + "px";
  }, { passive: true });

  // 25 秒没搭理它 → 伸个懒腰（一次性，然后继续呼吸）
  var idleTimer = null;
  var resetIdle = function () {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (petEl.style.display === "none" || petEl._bookOpen || petEl.classList.contains("dragging") ||
          petEl.getAttribute("data-busy") || Date.now() < Number(petEl._busyUntil || 0) ||
          document.documentElement.getAttribute("data-motion") === "eco") return;
      petEl.classList.add("yawn");
      setTimeout(function () { petEl.classList.remove("yawn"); }, 1000);
    }, 25000);
  };
  resetIdle();
  petEl.addEventListener("click", resetIdle);
}

  } catch (e) {}
})();
