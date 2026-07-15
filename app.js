/* ============================================================
   电玩日报 — 交互逻辑
   启动用本地缓存秒开 → 静默拉取 news.json(流水线数据,带全文)
   → 即时增量直连源站。收藏/已读/打卡天数本地持久化。
   ============================================================ */

(function () {
  const APP_BUILD = "v46 · 2026-07-05"; // 与 sw.js 缓存版本同步更新
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const CATEGORIES = ["全部", "关注", "业界", "主机", "PC", "手游"];
  const PALETTES = [
    { c1: "#3D5BF5", c2: "#1B2A8A", fg: "#fff" },
    { c1: "#E60012", c2: "#8E000B", fg: "#fff" },
    { c1: "#C9A227", c2: "#3B2A06", fg: "#FFF6DC" },
    { c1: "#16C79A", c2: "#0A6E55", fg: "#fff" },
    { c1: "#F953C6", c2: "#7B2FF7", fg: "#fff" },
    { c1: "#FF8A5C", c2: "#B23A1D", fg: "#fff" },
    { c1: "#2A475E", c2: "#101820", fg: "#66C0F4" },
    { c1: "#4A4E69", c2: "#22223B", fg: "#fff" },
  ];

  /* ---------- 本地存储 ---------- */

  const store = {
    get(key, fallback) {
      try {
        const v = JSON.parse(localStorage.getItem(key));
        return v == null ? fallback : v;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  /* ---------- 离线归档(IndexedDB):容量远超 localStorage 5MB,断网可秒开+翻历史 ----------
     只存 JSON/文字 + 图片 URL,不存图片二进制(图片由 SW 尽力缓存)。
     设计要点:每个操作开全新事务且绝不跨 await 持有(规避 iOS WKWebView 自动关闭事务);
     open 三秒看门狗超时即降级为 null;safeIdb 把任何失败/超时折叠成 undefined(≡未命中),
     于是各读取点已有的"未命中就走网络"分支天然成为兜底,无需新增判断。 */
  const HAS_IDB = (() => { try { return "indexedDB" in self && indexedDB != null; } catch { return false; } })();
  const IDB_NAME = "dianwan";
  const IDB_VERSION = 1;
  const SCHEMA = 1; // 数据形状版本:仅在 item 结构发生不兼容变更时才 +1(与 APP_BUILD 解耦)

  const idb = (() => {
    let dbPromise = null;
    function openDB() {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        const watchdog = setTimeout(() => done(null), 3000); // iOS 偶发 open 卡死/空库
        let req;
        try { req = indexedDB.open(IDB_NAME, IDB_VERSION); }
        catch { clearTimeout(watchdog); return done(null); }
        req.onupgradeneeded = (e) => {
          const db = req.result;
          switch (e.oldVersion) {
            case 0:
              if (!db.objectStoreNames.contains("snapshot")) db.createObjectStore("snapshot");
              if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "date" });
              if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
            // 后续版本在此向下贯穿追加迁移
          }
        };
        req.onsuccess = () => { clearTimeout(watchdog); done(req.result); };
        req.onerror = () => { clearTimeout(watchdog); done(null); };
        req.onblocked = () => { clearTimeout(watchdog); done(null); };
      });
    }
    function open() {
      if (!HAS_IDB) return Promise.resolve(null);
      if (!dbPromise) dbPromise = openDB().catch(() => null);
      return dbPromise;
    }
    // 一个逻辑操作 = 一个全新事务;请求同步发出,在 oncomplete 时取 req.result,绝不跨 await
    function run(stores, mode, fn) {
      return open().then((db) => {
        if (!db) return undefined;
        return new Promise((resolve, reject) => {
          let tx;
          try { tx = db.transaction(stores, mode); }
          catch (e) { return reject(e); }
          let out;
          try {
            const req = fn(tx);
            // 用 addEventListener 而非 .onsuccess,以免覆盖 fn 自己设的 onsuccess(如 pruneDays 的删除逻辑)
            if (req) req.addEventListener("success", () => { out = req.result; });
          } catch (e) {
            try { tx.abort(); } catch {}
            return reject(e);
          }
          tx.oncomplete = () => resolve(out);
          tx.onabort = () => reject(tx.error || new Error("idb abort"));
          tx.onerror = () => reject(tx.error || new Error("idb error"));
        });
      });
    }
    return {
      open,
      get: (s, k) => run(s, "readonly", (tx) => tx.objectStore(s).get(k)),
      keys: (s) => run(s, "readonly", (tx) => tx.objectStore(s).getAllKeys()),
      put: (s, v, k) => run(s, "readwrite", (tx) => (k === undefined ? tx.objectStore(s).put(v) : tx.objectStore(s).put(v, k))),
      clearAll: () => run(["snapshot", "days", "meta"], "readwrite", (tx) => {
        tx.objectStore("snapshot").clear();
        tx.objectStore("days").clear();
        tx.objectStore("meta").clear();
      }),
      // LRU 修剪:全量读出(天数有上限,记录小),按 lastAccess 升序删到满足上限
      pruneDays: (maxDays, softBytes) => run("days", "readwrite", (tx) => {
        const store = tx.objectStore("days");
        const all = store.getAll();
        all.onsuccess = () => {
          const recs = all.result || [];
          let total = recs.reduce((s, r) => s + (r.bytes || 0), 0);
          let count = recs.length;
          if (count <= maxDays && total <= softBytes) return;
          const order = recs.slice().sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
          for (const r of order) {
            if (count <= maxDays && total <= softBytes) break;
            store.delete(r.date);
            count--;
            total -= r.bytes || 0;
          }
        };
        return all;
      }),
    };
  })();

  // 把任意 IDB 操作的失败/超时折叠成 undefined(与"键不存在"无法区分,于是兜底无需新分支)
  // 超时设 3.5s,长于 open 的 3s 看门狗,避免首个操作在 open 即将就绪前就误超时
  const safeIdb = (p) =>
    Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(undefined), 3500))]).catch(() => undefined);

  // 瘦身镜像:剥掉每条 news 的 content(大头),其余字段全留 → localStorage 秒开且不撑配额
  function slimSnapshot(combined) {
    return {
      generatedAt: combined.generatedAt,
      sources: combined.sources || null,
      digest: combined.digest || null,
      news: (combined.news || []).map((n) => { const { content, ...rest } = n; return rest; }),
      flash: combined.flash || [],
    };
  }
  const approxBytes = (items) => { try { return JSON.stringify(items).length; } catch { return 0; } };
  const snapshotHasContent = (snap) => !!(snap && Array.isArray(snap.news) && snap.news.some((n) => n && n.content));

  const IDB_MAX_DAYS = 40;                 // > 流水线 30 天保留:被淘汰的天仍可重新下载
  const IDB_SOFT_BYTES = 40 * 1024 * 1024; // 软上限,主要靠天数封顶
  const HYDRATE_MAX_DAYS = 10;             // 启动只预载最近 N 天进内存,更早的随下滑按需从 IDB 取
  let prunedThisSession = false;
  let lastSnapshotGen = null;              // 上次写入 IDB 快照对应的 generatedAt,数据没变就不重复写 1.2MB
  function maybePrune() {
    if (!HAS_IDB || prunedThisSession) return;
    prunedThisSession = true; // 每会话最多修剪一次
    safeIdb(idb.pruneDays(IDB_MAX_DAYS, IDB_SOFT_BYTES));
  }
  const touchedDays = new Set();
  function touchDay(date) { // 更新 lastAccess(每会话每天一次,避免下滑时写抖动)
    if (!HAS_IDB || touchedDays.has(date)) return;
    touchedDays.add(date);
    safeIdb(idb.get("days", date)).then((rec) => { if (rec) safeIdb(idb.put("days", { ...rec, lastAccess: Date.now() })); });
  }
  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        const granted = already || (await navigator.storage.persist());
        safeIdb(idb.put("meta", !!granted, "persistGranted"));
      }
    } catch {}
  }

  const SEEN_KEY = "dianwanSeen";   // 已见过的新闻 key(用于"新增 N 条"与"上次看到这里"锚点)
  const SEEN_TS_KEY = "dianwanSeenTs"; // 上次记账时间戳,判定是否为"新会话"
  const CACHE_KEY = "dianwanCache"; // 上次成功拉取的数据(秒开用)
  const READ_KEY = "dianwanRead";   // 已读
  const FAV_KEY = "dianwanFavs";    // 收藏
  const LATER_KEY = "dwLater";      // 稍后读队列
  const VISIT_KEY = "dianwanVisits";// 打卡日期
  const WORKER_KEY = "dwWorker";    // 用户自建图片代理(Cloudflare Worker)网址
  const THEME_KEY = "dwTheme";      // 主题:auto | light | dark

  let WORKER_PROXY = store.get(WORKER_KEY, "");

  /* ---------- 主题(曜石暗 / 明)---------- */
  let themePref = store.get(THEME_KEY, "auto");
  const resolveTheme = (p) =>
    p === "light" || p === "dark" ? p : (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  function applyTheme(pref) {
    const t = resolveTheme(pref);
    if (t === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#F4F1E9" : "#0E0E11");
  }
  applyTheme(themePref); // 尽早应用,避免首屏闪烁
  // 选「跟随系统」时,系统切换即时跟随
  if (window.matchMedia) {
    try { matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (themePref === "auto") applyTheme("auto"); }); } catch {}
  }
  function setTheme(pref) {
    themePref = pref;
    store.set(THEME_KEY, pref);
    applyTheme(pref);
    renderMe();
  }

  /* ---------- 关注(游戏 / 来源)---------- */
  const FOLLOW_KEY = "dwFollow";
  const _follow = store.get(FOLLOW_KEY, {});
  const followGames = new Map(Array.isArray(_follow.games) ? _follow.games : []);   // 归一化键 → 展示原名
  const followSources = new Set(Array.isArray(_follow.sources) ? _follow.sources : []); // 来源名
  const persistFollow = () => store.set(FOLLOW_KEY, { games: [...followGames.entries()], sources: [...followSources] });
  const followCount = () => followGames.size + followSources.size;
  // 条目是否命中关注:关注的来源,或标题里有关注的《游戏》
  function itemFollowed(n) {
    if (followSources.has(n.source)) return true;
    if (followGames.size) {
      for (const m of (n.title || "").matchAll(/《([^》]+)》/g)) {
        if (followGames.has(threadKeyOf(normT(m[1])))) return true;
      }
    }
    return false;
  }
  function toggleFollowGame(name) {
    const k = threadKeyOf(normT(name || ""));
    if (k.length < 2) return;
    if (followGames.has(k)) { followGames.delete(k); toast(`已取消关注《${name}》`); }
    else { followGames.set(k, name); toast(`已关注《${name}》`); }
    persistFollow();
    renderChips();
    if (activeTab === "home" && activeCategory === "关注") renderFeed();
    if (activeTab === "me") renderMe();
    renderSearchFollow();
  }
  function toggleFollowSource(name) {
    if (followSources.has(name)) followSources.delete(name);
    else followSources.add(name);
    persistFollow();
    renderChips();
    if (activeTab === "home" && activeCategory === "关注") renderFeed();
    renderMe();
  }
  function unfollowGameKey(k) {
    if (!followGames.has(k)) return;
    const name = followGames.get(k);
    followGames.delete(k);
    persistFollow();
    toast(`已取消关注《${name}》`);
    renderChips();
    if (activeTab === "home" && activeCategory === "关注") renderFeed();
    renderMe();
    renderSearchFollow();
  }

  const readSet = new Set(store.get(READ_KEY, []));
  const itemKey = (n) => n.url || (n.title || "").slice(0, 24);

  /* ---------- 状态 ---------- */

  let D = window.GameNewsData; // 当前数据(缓存/演示兜底,刷新后替换)
  let renderGen = 0;           // 单调令牌:每次设置 D 都 +1,网络刷新永远盖过在途的 IDB 注水
  let threadIndexByKey = new Map(); // itemKey → 事件脉络 VM;仅在数据变化时由 rebuildThreads 重建
  let activeCategory = "全部";
  let searchQuery = "";
  let streakDays = 1;
  let currentDetailId = null;
  let currentDetailKey = null;
  let favViewItems = [];

  /* ---------- 工具 ---------- */

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const coverStyle = (cover) => `--c1:${cover.c1};--c2:${cover.c2};--fg:${cover.fg}`;

  function relTime(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
  }

  const videoBadge = (n) => (n.isVideo ? '<span class="video-badge">▶</span>' : "");

  /* ---------- 图片加载:四级兜底级联 ----------
     直连原图 → wsrv.nl 代理 → Photon(i0.wp.com,独立基础设施)→ 占位字形。
     任一级失败自动重试下一级,而非永久删除。覆盖:防盗链 403 / 混合内容 /
     国外被墙 / 单代理(Cloudflare 在华)失效 四种失败模式。
     国外源与 http-only 源直连必失败,直接从代理起跳(proxyByDefaultHosts)。 */

  const FOREIGN_RE = /ignimgs\.com|gamespot|cbsistatic\.com|chuapp\.com|futurecdn|pushsquare\.com|nintendolife\.com/i;
  const IMG_W = { thumb: 360, cover: 720, detail: 900, full: 1280 };

  // 旧数据可能已把图改写成 wsrv 链接,还原出原始 URL
  function unwrapProxy(u) {
    if (!u) return u;
    const m = u.match(/wsrv\.nl\/\?url=([^&]+)/) || u.match(/i0\.wp\.com\/(.+)$/);
    if (m) {
      let inner = decodeURIComponent(m[1]).replace(/^ssl:/, "").replace(/\?.*$/, "");
      return /^https?:\/\//.test(inner) ? inner : "https://" + inner;
    }
    return u;
  }

  const stripScheme = (u) => u.replace(/^https?:\/\//, "").replace(/^\/\//, "");
  const isHttpsSrc = (u) => /^https:/.test(u) || u.startsWith("//");

  function viaWorker(u, w) {
    if (!WORKER_PROXY) return null;
    return `${WORKER_PROXY.replace(/\/$/, "")}/?url=${encodeURIComponent(u)}`;
  }
  function viaWsrv(u, w) {
    const s = (isHttpsSrc(u) ? "ssl:" : "") + stripScheme(u);
    return `https://wsrv.nl/?url=${encodeURIComponent(s)}${w ? `&w=${w}&output=webp&q=78` : ""}`;
  }
  function viaPhoton(u, w) {
    const p = [];
    if (isHttpsSrc(u)) p.push("ssl=1");
    if (w) { p.push("w=" + w); p.push("quality=78"); }
    return `https://i0.wp.com/${stripScheme(u)}${p.length ? "?" + p.join("&") : ""}`;
  }

  // 代理优先级:用户自建 Worker(若配置)> wsrv.nl > Photon。返回有序生成器列表。
  function proxyChain() {
    const list = [];
    if (WORKER_PROXY) list.push(viaWorker);
    list.push(viaWsrv, viaPhoton);
    return list;
  }
  let PROXIES = proxyChain();

  const shouldStartProxied = (u) => /^http:\/\//.test(u) || u.startsWith("//") || FOREIGN_RE.test(u);

  // 决定初始 src:国外/协议相对/http 源跳过注定失败的直连,从首选代理起
  function imgSrc(orig, kind) {
    if (!orig) return "";
    const w = IMG_W[kind] || 0;
    return shouldStartProxied(orig) ? PROXIES[0](orig, w) : orig;
  }

  // 渲染一个带兜底链的 <img>;kind 决定压缩宽度,glyph 为终级占位字形
  // data-stage = 已尝试的代理个数(0=正显示直连;n=正显示 PROXIES[n-1])
  function imgTag(cls, orig, kind, glyph) {
    const w = IMG_W[kind] || 0;
    const proxied = shouldStartProxied(orig);
    return `<img class="${cls}" src="${esc(imgSrc(orig, kind))}" loading="lazy" referrerpolicy="no-referrer"` +
      ` data-orig="${esc(orig)}" data-w="${w}" data-stage="${proxied ? 1 : 0}"` +
      (glyph ? ` data-glyph="${esc(glyph)}"` : "") + ` onload="this.dataset.loaded=1" onerror="dwImgError(this)">`;
  }

  // 全局错误处理:沿 PROXIES 逐级降级,耗尽后占位
  window.dwImgError = function (img) {
    const orig = img.dataset.orig;
    const w = +img.dataset.w || 0;
    const stage = +img.dataset.stage || 0; // 已用代理数
    if (stage < PROXIES.length) {
      const next = PROXIES[stage](orig, w);
      img.dataset.stage = stage + 1;
      if (next) { img.src = next; return; }
    }
    // 终级:撤掉图片,缩略图/封面容器留渐变 + 字形,不塌不空
    img.onerror = null;
    const glyph = img.dataset.glyph;
    const parent = img.parentElement;
    img.remove();
    if (glyph && parent && /news-thumb|cover|topic-cover/.test(parent.className) && !parent.querySelector(".thumb-glyph,.cover-deco")) {
      const span = document.createElement("span");
      span.className = parent.className.includes("news-thumb") ? "thumb-glyph" : "cover-deco";
      span.textContent = glyph;
      parent.appendChild(span);
    }
  };

  // 挂起看门狗:国内网络对未代理的国外图址常"黑洞"挂起 —— onerror 几十秒不触发甚至不触发,
  // 缩略图会一直闪骨架、永远轮不到代理/字形兜底。6s 内既没 onload 也没自然报错就手动推进级联。
  function armImgWatchdogs(root) {
    (root || document).querySelectorAll("img[data-orig]:not([data-loaded]):not([data-wd])").forEach((img) => {
      img.dataset.wd = "1";
      const tick = () => {
        if (!img.isConnected || img.dataset.loaded) return;
        const stage = img.dataset.stage;
        dwImgError(img); // 推进一级代理,或耗尽后落到字形占位
        if (img.isConnected && !img.dataset.loaded && img.dataset.stage !== stage) setTimeout(tick, 6000);
      };
      setTimeout(tick, 6000);
    });
  }

  function coverMedia(n) {
    if (n.image) return imgTag("cover-img", n.image, "cover", n.cover.glyph);
    return `<span class="cover-deco">${esc(n.cover.glyph)}</span>`;
  }

  /* ---------- 数据归一化 ---------- */

  function sanitizeBlocks(content) {
    if (!Array.isArray(content)) return null;
    const blocks = content
      .map((b) => (b && b.t === "img" && typeof b.v === "string" && b.v.startsWith("//") ? { t: "img", v: "https:" + b.v } : b))
      .filter(
        (b) =>
          b &&
          typeof b.v === "string" &&
          (b.t === "p" || b.t === "h" || (b.t === "img" && /^https?:\/\//.test(b.v)))
      )
      .map((b) => (b.t === "img" ? { t: "img", v: unwrapProxy(b.v) } : b));
    return blocks.length ? blocks : null;
  }

  function normalizeItem(n, id) {
    const cleanUrl = /^https?:\/\//.test(n.url || "") ? n.url.replace(/["'\\]/g, "") : null;
    const rawImg = (n.image || "").replace(/["'\\]/g, "");
    // 存原始 URL(还原旧数据里已代理的链接),代理决策延后到渲染时
    const cleanImg = /^https?:\/\//.test(rawImg) || rawImg.startsWith("//") ? unwrapProxy(rawImg) : null;
    // 旧归档条目带着关键词扩充之前的旧分类,二游内容重新归入手游区
    let category = CATEGORIES.includes(n.category) ? n.category : "业界";
    if (category !== "手游" && categorizeClient(n.title + " " + (n.summary || "")) === "手游") category = "手游";
    return {
      id,
      category,
      title: n.title || "",
      titleEn: n.titleEn || null,
      short: n.title || "",
      summary: n.summary || "",
      source: n.source || "",
      ts: n.ts || 0,
      time: relTime(n.ts || Date.now()),
      comments: null,
      url: cleanUrl,
      image: cleanImg,
      isVideo: !!n.isVideo,
      hot: n.hot || 0, // 多源同报数(≥2 即热点)
      hotSources: Array.isArray(n.hotSources) ? n.hotSources : null,
      others: Array.isArray(n.others) ? n.others.filter((o) => o && o.url && /^https?:\/\//.test(o.url)) : null,
      official: !!n.official, // 官方一手公告(Steam 等)
      fullArchived: !!n.fullArchived, // 全文在当日归档文件中,详情页按需取
      cover: { ...PALETTES[id % PALETTES.length], glyph: (n.source || "News").slice(0, 2) },
      blocks: sanitizeBlocks(n.content),
      content: n.summary ? [n.summary] : [],
    };
  }

  function normalizeRemote(remote) {
    const news = (remote.news || []).map((n, i) => normalizeItem(n, n.id || i + 1));
    const byImageFirst = (arr) => [...arr].sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
    const featuredIds = byImageFirst(news).slice(0, 5).map((n) => n.id);
    // 专题区优先展示热点(多源同报);不足 2 条时回退编辑精选
    const hotItems = news.filter((n) => n.hot > 1);
    const topicPool =
      hotItems.length >= 2
        ? [...hotItems].sort((a, b) => b.hot - a.hot || (b.image ? 1 : 0) - (a.image ? 1 : 0))
        : byImageFirst(news.filter((n) => !featuredIds.includes(n.id)));
    const topicIds = topicPool.slice(0, 4).map((n) => n.id);
    const flash = (remote.flash || []).slice(0, 24).map((f) => ({
      time: new Date(f.ts || Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      text: esc(f.text),
      id: f.id || null,
    }));
    return {
      date: (remote.generatedAt || "").slice(0, 10),
      generatedAt: remote.generatedAt,
      sourceStats: remote.sources || null,
      featuredIds,
      topicIds,
      hotCount: hotItems.length,
      digest: remote.digest && Array.isArray(remote.digest.picks) && remote.digest.picks.length ? remote.digest : null,
      news,
      flash,
    };
  }

  /* ---------- 即时增量抓取(刷新时直连源站) ---------- */

  function categorizeClient(text) {
    if (/(手游|移动端|mobile game|TapTap|App ?Store|GooglePlay|开启预约|公测|内测|封测|抽卡|卡池|二次元|二游(?!戏)|原神|崩坏|星穹铁道|崩铁|绝区零|鸣潮|明日方舟|王者荣耀|和平精英|金铲铲|蛋仔|恋与深空|恋与制作人|无限暖暖|碧蓝航线|碧蓝档案|蔚蓝档案|FGO|公主连结|阴阳师|第五人格|光遇|尘白禁区|少女前线|战双|深空之眼|重返未来|白夜极光|雀魂|米哈游|米游社|库洛|鹰角|叠纸|莉莉丝|散爆|世界之外|如鸢|无期迷途|偶像梦幻祭)/i.test(text)) return "手游";
    if (/(PS5|PS4|PlayStation|Xbox|Switch|任天堂|Nintendo|主机|塞尔达|马里奥|console)/i.test(text)) return "主机";
    if (/(Steam|Epic|PC ?版|显卡|GOG|模组|\bMod\b|\bPC\b)/i.test(text)) return "PC";
    return "业界";
  }

  const stripTags = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

  function rssField(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (!m) return "";
    return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
  }

  function parseRss(xml, source, skipRe) {
    const out = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      if (out.length >= 12) break;
      const item = m[1];
      const url = rssField(item, "link");
      const title = stripTags(rssField(item, "title"));
      if (!url || !title || (skipRe && skipRe.test(url))) continue;
      const desc = rssField(item, "description");
      const img = rssField(item, "thumb") || desc.match(/<img[^>]+src="([^"]+)"/i)?.[1] || null;
      out.push({
        title,
        summary: stripTags(desc).slice(0, 110),
        source,
        url,
        image: img,
        isVideo: /\/videos?\//.test(url),
        ts: Date.parse(rssField(item, "pubDate")) || Date.now(),
      });
    }
    return out;
  }

  // 文本代理并行竞速:优先用户自建 Worker(配置后最可靠),并行公共代理兜底
  // (allorigins 已失效移除;corsproxy 校验浏览器来源、浏览器内可用但 Cloudflare 在华不稳)
  function proxyFetch(url) {
    const wrap = (p) =>
      fetch(p, { signal: AbortSignal.timeout(7000) }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      });
    const arms = [];
    if (WORKER_PROXY) arms.push(wrap(`${WORKER_PROXY.replace(/\/$/, "")}/?url=${encodeURIComponent(url)}`));
    arms.push(wrap(`https://corsproxy.io/?url=${encodeURIComponent(url)}`));
    arms.push(wrap(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`));
    return Promise.any(arms);
  }

  function parse3DMList(html) {
    const out = [];
    for (const m of html.matchAll(/<li class="selectpost">([\s\S]*?)<\/li>/g)) {
      if (out.length >= 20) break;
      const li = m[1];
      const a = li.match(/<a href="(https:\/\/www\.3dmgame\.com\/news\/\d{6}\/\d+\.html)"[^>]*class="bt"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const img = li.match(/<img[^>]+data-original="([^"]+)"/);
      const txt = li.match(/<div class="miaoshu">([\s\S]*?)<\/div>/);
      const time = li.match(/<span class="time">([^<]+)<\/span>/);
      out.push({
        title: stripTags(a[2]),
        summary: txt ? stripTags(txt[1]).slice(0, 110) : "",
        source: "3DM",
        url: a[1],
        image: img ? img[1] : null,
        isVideo: false,
        ts: time ? Date.parse(time[1].trim().replace(" ", "T") + "+08:00") || Date.now() : Date.now(),
      });
    }
    return out;
  }

  let jsonpSeq = 0;
  function fetchGamerskyJsonp(page = 1) {
    return new Promise((resolve, reject) => {
      const cb = `__dwGsCb${++jsonpSeq}`;
      const s = document.createElement("script");
      const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
      function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
      window[cb] = (data) => {
        const items = [];
        const html = (data && data.body) || "";
        for (const m of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
          if (items.length >= 14) break;
          const li = m[1];
          const a = li.match(/<a class="tt" href="(https:\/\/www\.gamersky\.com\/news\/\d{6}\/\d+\.shtml)"[^>]*>([\s\S]*?)<\/a>/);
          if (!a) continue;
          const img = li.match(/<img src="([^"]+)"/);
          const txt = li.match(/<div class="txt">([\s\S]*?)<\/div>/);
          const time = li.match(/<div class="time">([^<]+)<\/div>/);
          items.push({
            title: stripTags(a[2]),
            summary: txt ? stripTags(txt[1]).slice(0, 110) : "",
            source: "游民星空",
            url: a[1],
            image: img ? img[1] : null,
            isVideo: false,
            ts: time ? Date.parse(time[1].trim().replace(" ", "T") + ":00+08:00") || Date.now() : Date.now(),
          });
        }
        cleanup();
        resolve(items);
      };
      s.onerror = () => { cleanup(); reject(new Error("script error")); };
      s.src = `https://db2.gamersky.com/LabelJsonpAjax.aspx?callback=${cb}&jsondata=${encodeURIComponent(
        JSON.stringify({ type: "updatenodelabel", isCache: true, cacheTime: 60, nodeId: "11007", isNodeId: "true", page })
      )}`;
      document.head.appendChild(s);
    });
  }

  // 刷新时直连全部中文源(英文源更新慢且需翻译,交给流水线)
  async function fetchInstant() {
    const results = await Promise.allSettled([
      fetchGamerskyJsonp(1),
      fetchGamerskyJsonp(2),
      proxyFetch("https://www.gcores.com/rss").then((x) => parseRss(x, "机核", /\/radios\//)),
      proxyFetch("https://www.yystv.cn/rss/feed").then((x) => parseRss(x, "游研社")),
      proxyFetch("http://www.chuapp.com/feed").then((x) => parseRss(x, "触乐")),
      proxyFetch("https://indienova.com/feed/").then((x) => parseRss(x, "indienova")),
      proxyFetch("https://www.3dmgame.com/news/").then(parse3DMList),
    ]);
    return results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  }

  /* ---------- 刷新 ---------- */

  let refreshing = false;
  // 「上次看到这里」锚点:prevSessionSeen = 上个会话结束时已见的 key 集合;
  // 本次会话新抓到、且不在该集合里的条目排在锚点线之上。
  let prevSessionSeen = null;
  let lastActiveTs = Date.now();
  const NEW_SESSION_GAP = 30 * 60000; // 离开超过 30 分钟视为新会话,重划锚点
  function snapshotSeenBoundary() {
    // 仅当距上次记账确实超过一个会话间隔,才把"已见"快照为上次会话边界;否则不显示锚线
    const lastTs = store.get(SEEN_TS_KEY, 0);
    const seen = store.get(SEEN_KEY, []);
    prevSessionSeen = lastTs && Date.now() - lastTs > NEW_SESSION_GAP && seen.length ? new Set(seen) : new Set();
  }
  // 合并 news.json 与即时增量为统一数据集(按 URL/标题去重,整体按时间重排)
  function buildCombined(remote, instantResult) {
    const baseTitles = new Set(remote.news.map((n) => (n.title || "").slice(0, 18)));
    const baseUrls = new Set(remote.news.map((n) => n.url));
    const fresh = (instantResult || [])
      .filter((n) => !baseUrls.has(n.url) && !baseTitles.has(n.title.slice(0, 18)))
      .filter((n, i, arr) => arr.findIndex((x) => x.title.slice(0, 18) === n.title.slice(0, 18)) === i)
      .slice(0, 40)
      .map((n) => ({ ...n, category: categorizeClient(n.title + " " + n.summary), content: null }));
    const combinedNews = [...fresh, ...remote.news]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .map((n, i) => ({ ...n, id: i + 1 }));
    return {
      generatedAt: remote.generatedAt,
      sources: remote.sources || null,
      digest: remote.digest || null,
      news: combinedNews,
      flash: combinedNews.slice(0, 24).map((n) => ({ ts: n.ts, text: n.title, id: n.id })),
    };
  }

  // 落地数据集:更新 D/脉络/缓存;仅当"可见数据(generatedAt+条数)确有变化"才重渲,
  // 消除同数据反复整表重建导致的缩略图闪回占位、头条横滑架弹回。
  let shownSig = null;
  function applyCombined(combined, keepAnchor) {
    renderGen++; // 网络数据优先:让在途的 IDB 注水自动作废
    D = normalizeRemote(combined);
    rebuildThreads();
    const sig = (combined.generatedAt || "") + "#" + combined.news.length;
    if (sig !== shownSig) {
      shownSig = sig;
      if (keepAnchor) {
        renderHero(); renderFeatured(); renderChips(); renderDigest(); renderTopics(); renderFeedKeepAnchor(); renderFlash();
      } else {
        renderAll();
      }
    }
    store.set(CACHE_KEY, slimSnapshot(combined)); // 瘦身镜像 → localStorage,秒开且不撑 5MB 配额
    // 全量快照(含正文)落 IDB,仅 generatedAt 变化才写 ~1.2MB,避免前台切换反复写
    if (combined.generatedAt && combined.generatedAt !== lastSnapshotGen) {
      lastSnapshotGen = combined.generatedAt;
      safeIdb(idb.put("snapshot", { ...combined, savedAt: Date.now(), schemaTag: SCHEMA }, "current"));
      safeIdb(idb.put("meta", combined.generatedAt, "windowGeneratedAt"));
    }
    // 正在阅读的文章若在新数据里有了全文,就地补全
    if (currentDetailKey && !$("#detail").classList.contains("hidden")) {
      const freshItem = D.news.find((x) => itemKey(x) === currentDetailKey);
      if (freshItem && freshItem.blocks) { currentDetailId = freshItem.id; renderDetailBody(freshItem); }
    }
  }

  async function refresh(silent) {
    if (refreshing) return;
    refreshing = true;
    $$(".refresh-btn svg").forEach((s) => s.classList.add("spin"));
    try {
      // 即时增量后台并行,不阻塞 news.json 首渲(否则要等最慢的直连源/代理超时 7-8s)
      const instantP = fetchInstant().catch(() => []);
      // no-cache:内容未变时 GitHub Pages 返 304,省掉整包重传+重解析;加超时防弱网挂死
      const res = await fetch("news.json", { cache: "no-cache", signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const remote = await res.json();
      if (!remote.news || !remote.news.length) throw new Error("empty");

      // 第一段:仅用 news.json 立即上屏(≈1s),先让今日新闻可见
      const scrolledHome = activeTab === "home" && window.scrollY > 300;
      const combined0 = buildCombined(remote, []);
      applyCombined(combined0, silent && scrolledHome);

      // 第二段:即时增量到了再补(可能为空或全重复);二次渲染一律保锚,避免正在读时跳动
      const instantResult = await instantP;
      let finalCombined = combined0;
      if (instantResult.length) {
        const combined1 = buildCombined(remote, instantResult);
        if (combined1.news.length !== combined0.news.length) {
          applyCombined(combined1, true);
          finalCombined = combined1;
        }
      }

      // 记账"已见"key(每次刷新都记,供信息流「上次看到这里」锚点);toast/回顶仅手动刷新
      const keys = finalCombined.news.map(itemKey);
      const prev = store.get(SEEN_KEY, []);
      const prevSet = new Set(prev);
      const freshCount = keys.filter((k) => !prevSet.has(k)).length;
      store.set(SEEN_KEY, [...new Set([...keys, ...prev])].slice(0, 600));
      store.set(SEEN_TS_KEY, Date.now());
      if (!silent) {
        toast(
          prev.length === 0
            ? `已更新 · ${finalCombined.news.length} 条新闻`
            : freshCount > 0
              ? `比上次刷新新增 ${freshCount} 条`
              : "已是最新,没有新内容"
        );
        // 有新内容且正处默认视图(全部·无搜索)时才回顶;分区/搜索语境保留给用户
        if (freshCount > 0 && activeTab === "home" && activeCategory === "全部" && !searchQuery) {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      }
    } catch (err) {
      if (!silent) toast("刷新失败,显示已缓存内容");
    } finally {
      refreshing = false;
      $$(".refresh-btn svg").forEach((s) => s.classList.remove("spin"));
    }
  }

  /* ---------- 打卡/统计 ---------- */

  function updateVisits() {
    const today = new Date().toLocaleDateString("sv");
    let days = store.get(VISIT_KEY, []);
    if (!days.includes(today)) {
      days.push(today);
      days = days.slice(-60);
      store.set(VISIT_KEY, days);
    }
    const set = new Set(days);
    let streak = 0;
    for (let i = 0; ; i++) {
      const d = new Date(Date.now() - i * 86400000).toLocaleDateString("sv");
      if (set.has(d)) streak++;
      else break;
    }
    return Math.max(1, streak);
  }

  const getFavs = () => store.get(FAV_KEY, []);

  function persistRead() {
    store.set(READ_KEY, [...readSet].slice(-800));
  }

  /* ---------- 渲染 ---------- */

  function renderHero() {
    $("#headline").innerHTML = `今日 ${D.news.length} 条<br>游戏新闻`;
    $("#streakTitle").textContent = `${streakDays >= 7 ? "🔥 " : ""}连续追新 ${streakDays} 天`;
    $("#streakSub").textContent = `已读 ${readSet.size} 篇 · 收藏 ${getFavs().length} 条`;
    $("#flashDate").textContent = `${D.date || ""} · 实时业界动态速递`;
    const srcCount = D.sourceStats ? Object.keys(D.sourceStats).length : 0;
    const note = D.generatedAt
      ? `来源:${srcCount ? srcCount + " 家媒体" : "多家媒体"} · 更新于 ${new Date(D.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "演示数据 · 下拉刷新获取真实新闻";
    $$(".demo-note").forEach((el) => (el.textContent = note));
  }

  function renderFeatured() {
    const row = $("#featuredRow");
    const keepLeft = row ? row.scrollLeft : 0;
    const items = D.featuredIds.map(findNews).filter(Boolean);
    $("#featuredCount").textContent = items.length;
    row.innerHTML = items
      .map(
        (n) => `
      <div class="cover${n.image ? " has-img" : ""}" style="${coverStyle(n.cover)}" data-id="${n.id}">
        ${coverMedia(n)}${videoBadge(n)}
        <span class="cover-tag">${esc(n.category)}</span>
        <div class="cover-title">${esc(n.short)}</div>
        <div class="cover-sub">${esc(n.source)} · ${esc(n.time)}</div>
      </div>`
      )
      .join("");
    if (keepLeft) row.scrollLeft = keepLeft; // 重渲后保留头条横滑位置,不弹回第一张
  }

  function renderChips() {
    $("#chipsRow").innerHTML = CATEGORIES.map((cat) => {
      const count =
        cat === "全部" ? D.news.length : cat === "关注" ? D.news.filter(itemFollowed).length : D.news.filter((n) => n.category === cat).length;
      return `<button class="chip${cat === activeCategory ? " chip-on" : ""}" data-cat="${cat}">${cat === "关注" ? "★ 关注" : cat}<span class="chip-count">${count}</span></button>`;
    }).join("");
  }

  function renderTopics() {
    const hot = D.hotCount || 0;
    $("#topicTitle").textContent = hot >= 2 ? "今日热点" : "编辑精选";
    $("#topicSub").innerHTML = hot >= 2 ? "多家媒体同时在报<br>的热门事件" : "本时段最值得看的<br>游戏新闻";
    $("#topicNum").innerHTML = `${hot >= 2 ? hot : D.news.length}<span>${hot >= 2 ? "热点" : "条"}</span>`;
    $("#topicGrid").innerHTML = D.topicIds
      .map(findNews)
      .filter(Boolean)
      .map(
        (n) => `
      <div class="topic-cover${n.image ? " has-img" : ""}" style="${coverStyle(n.cover)}" data-id="${n.id}">
        ${coverMedia(n)}${videoBadge(n)}
        <div class="topic-cover-title">${esc(n.short)}</div>
      </div>`
      )
      .join("");
  }

  // 事件脉络徽章:只挂在脉络最新一条上(headKey),且不凑成第三枚徽章
  function threadBadge(n) {
    const t = threadIndexByKey.get(itemKey(n));
    if (!t || t.headKey !== itemKey(n)) return "";
    if (n.official && n.hot > 1) return ""; // 已有 官方+🔥 两枚,脉络让位(详情页仍展示)
    return `<span class="thread-badge">脉络</span>`;
  }

  function newsItemHtml(n) {
    const read = readSet.has(itemKey(n)) ? " is-read" : "";
    return `
      <article class="news-item${read}" data-id="${n.id}">
        <div class="news-main">
          <span class="news-cat">${esc(n.category)}</span>${n.official ? `<span class="off-badge">官方</span>` : ""}${n.hot > 1 ? `<span class="hot-badge">🔥 ${n.hot} 源同报</span>` : ""}${threadBadge(n)}
          <h4 class="news-title">${esc(n.title)}</h4>
          <div class="news-meta">
            <span>${esc(n.source)}</span><span>${esc(n.time)}</span>
          </div>
        </div>
        <div class="news-thumb" style="${coverStyle(n.cover)}">
          ${n.image ? imgTag("thumb-img", n.image, "thumb", n.cover.glyph) : `<span class="thumb-glyph">${esc(n.cover.glyph)}</span>`}
          ${videoBadge(n)}
        </div>
      </article>`;
  }

  function formatDay(d) {
    const [y, m, dd] = d.split("-").map(Number);
    const wd = "日一二三四五六"[new Date(y, m - 1, dd).getDay()];
    return `${m} 月 ${dd} 日 · 周${wd}`;
  }

  const dayKeyOf = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);

  /* ---------- 展示层同题去重(与流水线同款匹配器,兜住跨轮次漏网) ---------- */

  const normT = (t) => t.toLowerCase().replace(/[^一-鿿a-z0-9]/g, "");
  const bigramsOf = (s) => {
    const o = new Set();
    for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2));
    return o;
  };
  const overlapOf = (a, b) => {
    const A = bigramsOf(a), B = bigramsOf(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const x of A) if (B.has(x)) n++;
    return n / Math.min(A.size, B.size);
  };
  const gameNamesOf = (t) => [...t.matchAll(/《([^》]+)》/g)].map((m) => normT(m[1]));
  const STORY_BOILER = /(将于|正式|登陆|发售|公布|宣布|确认|推出|上线|预购|开启|即将|官方|官宣|致谢|发文|突破|曝|nintendoswitch2?|switch2?|playstation|ps5|ps4|xboxseries|xbox|steam|\d+)/g;
  const normNameOf = (s) => s.replace(/(remake|re|hd|重制版|代号)/gi, "");
  function sameStoryClient(a, b) {
    const na = gameNamesOf(a.title), nb = gameNamesOf(b.title);
    let named = false;
    if (na.length && nb.length) {
      outer: for (const x0 of na)
        for (const y0 of nb) {
          const x = normNameOf(x0), y = normNameOf(y0);
          if (x.length < 2 || y.length < 2) continue;
          if (x === y || x.includes(y) || y.includes(x) || overlapOf(x, y) >= 0.6) {
            named = true;
            break outer;
          }
        }
    }
    if (named) {
      if (Math.abs((a.ts || 0) - (b.ts || 0)) > 36 * 3600 * 1000) return false;
      let ra = normT(a.title);
      let rb = normT(b.title);
      for (const n of [...na, ...nb]) {
        for (const v of [n, normNameOf(n)]) {
          if (v.length >= 2) {
            ra = ra.split(v).join("");
            rb = rb.split(v).join("");
          }
        }
      }
      ra = ra.replace(STORY_BOILER, "");
      rb = rb.replace(STORY_BOILER, "");
      if (ra.length < 4 && rb.length < 4) return true;
      return overlapOf(ra, rb) >= 0.25;
    }
    const sa = normT(a.title).replace(STORY_BOILER, "");
    const sb = normT(b.title).replace(STORY_BOILER, "");
    if (sa.length < 4 || sb.length < 4) return false;
    return overlapOf(sa, sb) >= 0.6;
  }

  /* ---------- 事件脉络:把同一主体(《》游戏名)的多源连续报道串成时间线 ----------
     纯前端,仅在数据变化时重算(刷新/翻历史/注水/清缓存),绝不在滚动/筛选时跑。
     只串"有命名实体 + 跨源(≥2 家) + 多进展(≥2 条) + 14 天内"的发展中事件,
     无实体/单源/陈旧的一概不串(否则就是噪声)。横向同刻同报已由「各家怎么说」覆盖。 */
  const THREAD_SPAN = 14 * 864e5;   // 簇首尾跨度硬上限:14 天(防贪心串成长尾杂烩)
  const MAX_THREAD_ITEMS = 12;      // 资格阶段每簇最多保留的进展数
  const THREAD_DISPLAY = 7;         // 详情页时间线最多显示
  // 实体键:只剥版本/边缘词(remake/hd/重制版…),保留结尾数字 —— 数字常是编号系列的身份
  // (最终幻想7 ≠ 最终幻想16;但 最终幻想7重制版 == 最终幻想7)。宁可少合并,不可错合并不同正作。
  const threadKeyOf = (name) => normNameOf(name).trim();

  function rebuildThreads() {
    rebuildRiver(); // 同一数据变化点顺带重算规范长河,renderFeed 之后只做轻量筛选
    threadIndexByKey = new Map();
    if (!D || !D.news) return;
    // 1) 按 itemKey 去重(窗口副本优先,带 blocks),按 ts 降序
    const seen = new Set();
    const items = [];
    for (const n of [...D.news, ...history.flatMap((g) => g.items)]) {
      const k = itemKey(n);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(n);
    }
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // 2) 实体分桶 + 贪心成簇(新条须在簇内最新一条的 14 天跨度内,否则另起一簇)
    const clustersByEk = new Map();
    for (const n of items) {
      const ents = [...new Set(gameNamesOf(n.title).map(threadKeyOf).filter((s) => s.length >= 2))].sort();
      if (!ents.length) continue; // 无命名实体:不串脉络
      const ek = ents.join("|");
      const list = clustersByEk.get(ek);
      let c = list && list.find((cand) => (cand.latestTs - (n.ts || 0)) <= THREAD_SPAN);
      if (!c) {
        c = { items: [], latestTs: n.ts || 0 };
        if (list) list.push(c);
        else clustersByEk.set(ek, [c]);
      }
      c.items.push(n); // items 已降序,故 latestTs 恒为簇首条
    }

    const now = Date.now();
    for (const [, clusters] of clustersByEk) {
      const qualified = [];
      for (const c of clusters) {
        const beats = collapseBeats(c.items); // 同日同事去重 → 按 ts 降序的"进展"
        const sources = new Set();
        beats.forEach((b) => b.sources.forEach((s) => sources.add(s)));
        const span = (beats[0]?.ts || 0) - (beats[beats.length - 1]?.ts || 0);
        const recent = now - (beats[0]?.ts || 0) <= THREAD_SPAN;
        const distinctDays = new Set(beats.map((b) => b.day)).size;
        // 资格:≥2 进展 + ≥2 来源 + 跨≥2 天(脉络须随时间演进,同刻多家同报归「各家怎么说」)
        //       + 跨度≤14 天 + 14 天内仍活跃
        if (beats.length >= 2 && sources.size >= 2 && distinctDays >= 2 && span <= THREAD_SPAN && recent) {
          qualified.push({
            beats: beats.slice(0, MAX_THREAD_ITEMS),
            latestTs: beats[0].ts,
            official: beats.some((b) => b.official),
          });
        }
      }
      // 同实体最多留 2 条最近脉络(有官方公告时放宽到 3),避免常青游戏刷屏
      qualified.sort((a, b) => b.latestTs - a.latestTs);
      const cap = qualified.some((q) => q.official) ? 3 : 2;
      for (const thread of qualified.slice(0, cap)) {
        const vm = {
          total: thread.beats.length,
          headKey: thread.beats[0].key, // 最新一条:信息流徽章只挂在它上面,避免同一脉络重复刷屏
          beats: thread.beats.map((b) => ({
            key: b.key,
            title: b.title,
            source: b.source,
            ts: b.ts,
            day: b.day,
            sourceCount: b.sources.size,
          })),
        };
        for (const b of vm.beats) if (!threadIndexByKey.has(b.key)) threadIndexByKey.set(b.key, vm);
      }
    }
  }

  // 簇内同日同事件合并为一条"进展"(复用 sameStoryClient),来源并集计入 sources;不改原对象
  function collapseBeats(clusterItems) {
    const beats = [];
    for (const n of clusterItems) {
      const day = dayKeyOf(n.ts || 0);
      const nt = normT(n.title);
      let merged = null;
      for (const b of beats) {
        // 跨任意天:标题归一后相同 = 同一条被重复报道,合并(保留更新的,即已在 beats 里的)
        // 同一天:标题不同但同事件,也并为一条
        if (b.nt === nt || (b.day === day && sameStoryClient(b.rep, n))) { merged = b; break; }
      }
      const extra = Array.isArray(n.hotSources) ? n.hotSources : [];
      if (merged) {
        merged.sources.add(n.source);
        extra.forEach((s) => merged.sources.add(s));
      } else {
        const sources = new Set([n.source]);
        extra.forEach((s) => sources.add(s));
        beats.push({ key: itemKey(n), rep: n, title: n.title, nt, source: n.source, ts: n.ts || 0, day, sources, official: !!n.official });
      }
    }
    return beats; // ts 降序(clusterItems 已降序)
  }

  // 详情页事件脉络面板(复用 .src-panel/.src-row 外壳)
  function renderDetailThread(n) {
    const el = $("#detailThread");
    if (!el) return;
    const thread = n ? threadIndexByKey.get(itemKey(n)) : null;
    if (!thread || thread.total < 2) { el.innerHTML = ""; return; }
    const curKey = itemKey(n);
    const rows = thread.beats
      .slice(0, THREAD_DISPLAY)
      .map((b) => {
        const dayLabel = formatDay(b.day).replace(/ · 周.$/, "");
        // 来源作为正文后的浅色内联补充:多源时标"· N 源"(佐证强度),单源标来源名;不占独立列以免窄屏挤压
        const srcSuffix = b.sourceCount > 1 ? `<span class="src-meta"> · ${b.sourceCount} 源</span>` : "";
        const inner = `<span class="src-name">${esc(dayLabel)}</span><span class="src-t">${esc(b.title)}${srcSuffix}</span>`;
        return b.key === curKey
          ? `<div class="src-row src-row-cur">${inner}</div>`
          : `<a class="src-row" data-key="${esc(b.key)}">${inner}</a>`;
      })
      .join("");
    const more = thread.total > THREAD_DISPLAY ? `<div class="src-row thread-more">…更早 ${thread.total - THREAD_DISPLAY} 条</div>` : "";
    el.innerHTML = `<div class="src-panel thread-panel"><div class="src-panel-h">事件脉络 · ${thread.total} 条进展</div>${rows}${more}</div>`;
  }

  // 规范长河:窗口∪已加载归档 → itemKey 去重 → 时间倒序 → 72h 同题合并(并入来源计 🔥)。
  // 只在数据变化时(刷新/翻历史/注水/清缓存)重算;搜索/切区/滑动只做轻量筛选,丝滑很多。
  let _river = null;
  function rebuildRiver() {
    if (!D || !D.news) { _river = []; return; }
    const seenK = new Set();
    const arr = [];
    for (const n of [...D.news, ...history.flatMap((g) => g.items)]) {
      const k = itemKey(n);
      if (seenK.has(k)) continue;
      seenK.add(k);
      arr.push(n);
    }
    arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const deduped = [];
    for (const n of arr) {
      let dup = null;
      for (let i = deduped.length - 1; i >= 0; i--) {
        const k = deduped[i];
        if ((k.ts || 0) - (n.ts || 0) > 72 * 3600 * 1000) break;
        if (sameStoryClient(k, n)) { dup = k; break; }
      }
      if (dup) {
        dup.hotSources = dup.hotSources || [dup.source];
        if (!dup.hotSources.includes(n.source)) { dup.hotSources.push(n.source); dup.hot = dup.hotSources.length; }
        continue;
      }
      deduped.push(n);
    }
    _river = deduped;
  }

  // 窗口 + 已加载归档合并成一条连续时间长河(去重,按时间倒序,按天分隔)
  function renderFeed() {
    if (!_river) rebuildRiver();
    const q = searchQuery.toLowerCase();
    const match = (n) =>
      (activeCategory === "全部" || (activeCategory === "关注" ? itemFollowed(n) : n.category === activeCategory)) &&
      (!q || (n.title + " " + n.summary + " " + n.source).toLowerCase().includes(q));
    const river = _river.filter(match);
    riverOrder = river; // 详情页「下一篇」按当前信息流顺序

    const todayKey = dayKeyOf(Date.now());
    const yesterdayKey = dayKeyOf(Date.now() - 86400000);
    // 会话锚点「上次看到这里」:仅默认视图(全部·无搜索)显示,其上方即本次新增
    const showSeenLine = activeCategory === "全部" && !searchQuery && prevSessionSeen && prevSessionSeen.size;
    let lastDay = null;
    let seenPlaced = false;
    let placedItems = 0;
    let html = "";
    for (const n of river) {
      if (showSeenLine && !seenPlaced && placedItems > 0 && prevSessionSeen.has(itemKey(n))) {
        html += `<div class="feed-day feed-seen">上次看到这里</div>`;
        seenPlaced = true;
      }
      const d = n.ts ? dayKeyOf(n.ts) : todayKey;
      if (d !== lastDay) {
        lastDay = d;
        if (d !== todayKey) {
          html += `<div class="feed-day">${d === yesterdayKey ? "昨天" : formatDay(d)}</div>`;
        }
      }
      html += newsItemHtml(n);
      placedItems++;
    }
    if (!html && q) html = `<p class="feed-empty">没有找到包含「${esc(searchQuery)}」的新闻<br><span>搜索范围是已加载的新闻,下滑加载更多历史后可再搜</span></p>`;
    else if (!html && activeCategory === "关注")
      html = `<p class="feed-empty">${followCount() ? "关注的内容暂无新报道" : "还没关注任何游戏或来源"}<br><span>在「快讯」页的本周风向 / 近期发售点开某游戏,顶部点「★ 关注」;或在「我的」页关注来源</span></p>`;
    $("#feedList").innerHTML = html;
    armImgWatchdogs(); // 全局武装未完成的缩略图(含头条/专题/hero,均在文档内)
  }

  // 加载历史后保持视口锚点,避免上方插入内容导致跳动
  function renderFeedKeepAnchor() {
    const anchor = [...document.querySelectorAll("#feedList .news-item")].find(
      (el) => el.getBoundingClientRect().bottom > 80
    );
    const aId = anchor?.dataset.id;
    const aTop = anchor ? anchor.getBoundingClientRect().top : 0;
    renderFeed();
    if (aId) {
      const el = document.querySelector(`#feedList .news-item[data-id="${aId}"]`);
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - aTop);
    }
  }

  function renderFlash() {
    $("#flashList").innerHTML = D.flash
      .map((f, i) => {
        const body = f.id ? `<span class="flash-go" data-id="${f.id}">${f.text}</span>` : f.text;
        return `
      <div class="flash-item">
        <span class="flash-time">${esc(f.time)}</span>
        ${i < D.flash.length - 1 ? '<span class="flash-line"></span>' : ""}
        <span class="flash-dot"></span>
        <p class="flash-text">${body}</p>
      </div>`;
      })
      .join("");
    renderWeekly();
    renderReleases();
  }

  /* ---------- 周度风向报告:对已加载的近 7 天数据做纯前端统计(总量/分区占比/热议/高频游戏) ---------- */
  const WEEK_MS = 7 * 864e5;
  const CAT_COLOR = { 业界: "#8A8FB0", 主机: "#E0607A", PC: "#6FB7FF", 手游: "#16C79A" };

  function buildWeekly() {
    const weekAgo = Date.now() - WEEK_MS;
    const seen = new Set();
    const week = [];
    for (const n of [...D.news, ...history.flatMap((g) => g.items)]) {
      const k = itemKey(n);
      if (seen.has(k)) continue;
      seen.add(k);
      if ((n.ts || 0) >= weekAgo) week.push(n);
    }
    if (week.length < 8) return null; // 数据太少不出报告
    week.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // 覆盖日期范围(用归档日键直接取月.日,避免"近 8 天"这类因滚动窗跨日产生的歧义)
    const mdOf = (ts) => { const p = dayKeyOf(ts || 0).split("-"); return `${+p[1]}.${+p[2]}`; };
    const range = `${mdOf(week[week.length - 1].ts)}–${mdOf(week[0].ts)}`;

    const catCount = { 业界: 0, 主机: 0, PC: 0, 手游: 0 };
    week.forEach((n) => { if (catCount[n.category] != null) catCount[n.category]++; });
    const cats = Object.entries(catCount).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);

    // 本周热议:多源同报(hot>1)按热度排序,同事件去重,取前 5
    const topStories = [];
    for (const n of week.filter((n) => (n.hot || 0) > 1).sort((a, b) => (b.hot || 0) - (a.hot || 0))) {
      if (topStories.some((s) => sameStoryClient(s, n))) continue;
      topStories.push(n);
      if (topStories.length >= 5) break;
    }

    // 高频游戏:《》实体计数(归一键去重,保留首见原名展示),≥2 次,取前 8
    const games = new Map();
    for (const n of week) {
      const seenKeys = new Set();
      for (const m of (n.title || "").matchAll(/《([^》]+)》/g)) {
        const orig = m[1].trim();
        const key = threadKeyOf(normT(orig));
        if (key.length < 2 || seenKeys.has(key)) continue;
        seenKeys.add(key);
        const cur = games.get(key) || { count: 0, display: orig };
        cur.count++;
        games.set(key, cur);
      }
    }
    const topGames = [...games.values()].filter((g) => g.count >= 2).sort((a, b) => b.count - a.count).slice(0, 8);

    return { total: week.length, range, cats, topStories, topGames };
  }

  function renderWeekly() {
    const el = $("#weeklyReport");
    if (!el) return;
    const w = buildWeekly();
    if (!w) { el.innerHTML = ""; return; }

    const bar = w.cats
      .map(([c, n]) => `<span class="week-seg" style="flex:${n};background:${CAT_COLOR[c] || "#8A8FB0"}"></span>`)
      .join("");
    const legend = w.cats
      .map(([c, n]) => `<span class="week-leg"><i style="background:${CAT_COLOR[c] || "#8A8FB0"}"></i>${c} ${Math.round((n / w.total) * 100)}%</span>`)
      .join("");

    const stories = w.topStories
      .map(
        (n) =>
          `<button class="digest-pick" data-id="${n.id}"><b>${esc(n.title)}</b><span>🔥 ${n.hotSources ? esc(n.hotSources.join("、")) : n.hot + " 家媒体"} 同报</span></button>`
      )
      .join("");

    const games = w.topGames
      .map((g) => `<span class="src-pill week-game" data-game="${esc(g.display)}">《${esc(g.display)}》 <b>${g.count}</b></span>`)
      .join("");

    el.innerHTML =
      `<div class="digest weekly">` +
      `<div class="digest-head"><span class="digest-tag">▲ 本周风向</span><span class="digest-date">${w.range} · ${w.total} 条</span></div>` +
      `<div class="week-bar">${bar}</div><div class="week-legend">${legend}</div>` +
      (stories ? `<div class="digest-label">本周热议</div>${stories}` : "") +
      (games ? `<div class="digest-label">高频游戏</div><div class="week-games">${games}</div>` : "") +
      `</div>`;
  }

  /* ---------- 发售表:从新闻标题/摘要抽「《游戏》+ 日期 + 发售类动词」做发售日历(纯前端) ---------- */
  const REL_KW = /发售|发行|上线|登[陆陸]|推出|上市|开售|解锁|首发|公测|开测|不删档|定档|跳票|延期|延后|抢先体验|发售日|正式版/;
  // 《》里常见的非游戏(杂志/音乐会/原声/书刊/影视),从发售表里剔掉
  const NON_GAME = /周刊|杂志|Jump|演唱会|音乐会|concert|orchestra|live recording|原声|OST|画集|设定集|小说|漫画|剧场版|番剧|蓝光/i;
  const RELEASE_MS_AHEAD = 540 * 864e5;

  function extractReleases(items) {
    const now = Date.now();
    const curY = new Date(now + 8 * 3600 * 1000).getUTCFullYear();
    const byGame = new Map(); // 游戏键 → 该游戏最新被报道的发售条目(避免同游戏多日期冲突)
    const seenKey = new Set();
    for (const n of items) {
      const k = itemKey(n);
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      const text = (n.title || "") + "　" + (n.summary || "");
      const gpos = [...text.matchAll(/《([^》]+)》/g)].map((m) => ({ name: m[1].trim(), idx: m.index }));
      if (!gpos.length) continue;
      const dateRe = /(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
      let m;
      while ((m = dateRe.exec(text))) {
        const ctx = text.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12);
        if (!REL_KW.test(ctx)) continue; // 日期附近须有发售类动词,否则多是无关日期
        const mo = +m[2], d = +m[3];
        if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
        let y = m[1] ? +m[1] : curY;
        if (!m[1] && Date.UTC(curY, mo - 1, d) - 8 * 3600 * 1000 < now - 45 * 864e5) y = curY + 1; // 未写年份且已过去较久→明年
        const ts = Date.UTC(y, mo - 1, d) - 8 * 3600 * 1000;
        if (ts < now - 21 * 864e5 || ts > now + RELEASE_MS_AHEAD) continue;
        // 把日期配给文本中位置最近的《游戏》(正确处理"《A》8月发售,《B》9月上线")
        let g = gpos[0], best = Infinity;
        for (const gp of gpos) { const dist = Math.abs(gp.idx - m.index); if (dist < best) { best = dist; g = gp; } }
        if (NON_GAME.test(g.name) || g.name.length > 20) continue; // 滤掉非游戏/超长(多为音乐会/特典名)
        const gk = threadKeyOf(normT(g.name));
        if (gk.length < 2) continue;
        const prev = byGame.get(gk);
        if (!prev || (n.ts || 0) > prev.newsTs) byGame.set(gk, { game: g.name, gk, ts, dateKey: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, source: n.source || "", newsTs: n.ts || 0 });
      }
    }
    return [...byGame.values()].sort((a, b) => a.ts - b.ts);
  }

  function renderReleases() {
    const el = $("#releaseCal");
    if (!el) return;
    const now = Date.now();
    const t = new Date(now + 8 * 3600 * 1000);
    const todayStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - 8 * 3600 * 1000;
    const list = extractReleases([...D.news, ...history.flatMap((g) => g.items)]).filter((r) => r.ts >= todayStart - 864e5);
    if (!list.length) { el.innerHTML = ""; return; }
    const shown = list.slice(0, 16);
    let rows = "", lastDate = "";
    for (const r of shown) {
      if (r.dateKey !== lastDate) {
        lastDate = r.dateKey;
        const days = Math.round((r.ts - todayStart) / 864e5);
        const when = days <= 0 ? "今天" : days === 1 ? "明天" : `${days} 天后`;
        rows += `<div class="rel-date">${esc(formatDay(r.dateKey))}<span class="rel-days">${when}</span></div>`;
      }
      rows += `<button class="rel-row" data-game="${esc(r.game)}"><span class="rel-game">《${esc(r.game)}》</span><span class="rel-src">${esc(r.source)}</span></button>`;
    }
    el.innerHTML =
      `<div class="digest release"><div class="digest-head"><span class="digest-tag">🗓 近期发售</span>` +
      `<span class="digest-date">${list.length} 款在即</span></div>${rows}</div>`;
  }

  // 高频游戏点按:回首页按该游戏名筛选信息流,并露出「★ 关注《X》」按钮
  let searchGameName = null; // 当前是否在按某个游戏筛选(决定是否显示关注按钮)
  function searchGame(name) {
    searchQuery = name;
    searchGameName = name;
    activeCategory = "全部";
    switchTab("home");
    const row = $("#searchRow");
    if (row) row.classList.remove("hidden");
    const inp = $("#searchInput");
    if (inp) inp.value = name;
    renderChips();
    renderFeed();
    renderSearchFollow();
    // 落点直接到「最新资讯」区,让筛选结果与搜索栏可见,而非停在首页顶部
    const feed = document.querySelector("#view-home .feed");
    if (feed) window.scrollTo(0, Math.max(0, feed.getBoundingClientRect().top + window.scrollY - 56));
  }

  // 切换分区时清掉搜索筛选,避免"分区 ∩ 上次搜索"导致的意外空结果
  function clearSearchFilter() {
    if (!searchQuery && !searchGameName) return;
    searchQuery = "";
    searchGameName = null;
    const inp = $("#searchInput");
    if (inp) inp.value = "";
    $("#searchRow")?.classList.add("hidden");
    renderSearchFollow();
  }

  // 搜索栏里的关注按钮:仅当在按某游戏筛选时显示
  function renderSearchFollow() {
    const btn = $("#searchFollow");
    if (!btn) return;
    if (!searchGameName) { btn.classList.add("hidden"); return; }
    const followed = followGames.has(threadKeyOf(normT(searchGameName)));
    btn.classList.remove("hidden");
    btn.classList.toggle("on", followed);
    btn.textContent = followed ? "★ 已关注" : "☆ 关注";
  }

  let favMode = "fav";    // "fav" | "later"
  let favSearch = "";
  let favGroup = "全部";  // 按《游戏》分组的归一键
  let galTrackKey = null; // 当前图集所属文章 key + 其横向滚动位置(重渲时保留)
  let galTrackScroll = 0;

  function renderFavs() {
    const raw = favMode === "fav" ? getFavs() : getLater();
    const all = [...raw].reverse().map((f, i) => normalizeItem(f, 200000 + i));
    favViewItems = all; // findNews 据此解析点开

    // 分组 chips:全部 + 出现的游戏(按次数 top 8)
    const games = new Map();
    for (const n of all)
      for (const m of (n.title || "").matchAll(/《([^》]+)》/g)) {
        const k = threadKeyOf(normT(m[1]));
        if (k.length < 2) continue;
        const cur = games.get(k) || { name: m[1].trim(), n: 0 };
        cur.n++;
        games.set(k, cur);
      }
    if (favGroup !== "全部" && !games.has(favGroup)) favGroup = "全部"; // 切模式后失效则回退
    const tops = [...games.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    const fc = $("#favChips");
    if (fc)
      fc.innerHTML = tops.length
        ? [`<button class="chip fav-chip${favGroup === "全部" ? " chip-on" : ""}" data-fav-group="全部">全部</button>`]
            .concat(tops.map(([k, v]) => `<button class="chip fav-chip${favGroup === k ? " chip-on" : ""}" data-fav-group="${esc(k)}">《${esc(v.name)}》</button>`))
            .join("")
        : "";

    // 过滤:搜索 + 分组
    let items = all;
    const q = favSearch.toLowerCase();
    if (q) items = items.filter((n) => (n.title + " " + n.summary + " " + n.source).toLowerCase().includes(q));
    if (favGroup !== "全部")
      items = items.filter((n) => [...(n.title || "").matchAll(/《([^》]+)》/g)].some((m) => threadKeyOf(normT(m[1])) === favGroup));

    $("#favsList").innerHTML = items
      .map((n) => `<div class="saved-wrap">${newsItemHtml(n)}<button class="saved-rm" data-rm-key="${esc(itemKey(n))}" aria-label="移除">✕</button></div>`)
      .join("");
    $("#favsEmpty").innerHTML =
      all.length === 0
        ? (favMode === "fav" ? "还没有收藏<br>打开任意新闻,点底部「⭐ 收藏」" : "稍后读是空的<br>打开新闻点底部「🕘 稍后」,攒起来慢慢看")
        : "没有匹配的条目<br>换个关键词或分组试试";
    $("#favsEmpty").classList.toggle("hidden", items.length > 0); // 按"筛选后"为空判断,避免搜索无结果时空白
    $("#favsCount").textContent = all.length
      ? `${favMode === "fav" ? "收藏" : "稍后读"} · ${q || favGroup !== "全部" ? items.length + "/" : ""}${all.length} 条`
      : favMode === "fav" ? "打开新闻点「⭐ 收藏」保存" : "打开新闻点「🕘 稍后」攒起来";
    $("#favSeg")?.querySelectorAll("button").forEach((b) => b.classList.toggle("seg-on", b.dataset.favMode === favMode));
  }

  function removeSaved(key) {
    const K = favMode === "fav" ? FAV_KEY : LATER_KEY;
    store.set(K, store.get(K, []).filter((f) => itemKey(f) !== key));
    renderFavs();
  }

  function renderMe() {
    $("#meStreak").textContent = streakDays;
    $("#meRead").textContent = readSet.size;
    $("#meFavs").textContent = getFavs().length;
    $("#meDate").textContent = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
    $("#meBuild").textContent = `电玩日报 ${APP_BUILD}`;
    // 来源健康度:最近一轮各源抓取条数,挂了的一眼可见
    const stats = D.sourceStats;
    $("#meSources").innerHTML = stats
      ? Object.entries(stats)
          .map(
            ([name, count]) =>
              `<span class="src-pill${count === 0 ? " src-dead" : ""}">${esc(name)} <b>${count}</b></span>`
          )
          .join("")
      : "游民星空 · 3DM · 游侠网 · A9VG · 机核 · 游研社 · 触乐 · 17173 · indienova · IGN · GameSpot · PC Gamer · Push Square · Nintendo Life · Steam";
    const wi = $("#meWorker");
    if (wi) wi.value = WORKER_PROXY;
    const ws = $("#meWorkerState");
    if (ws) ws.textContent = WORKER_PROXY ? "已启用自建图片代理" : "未配置(默认用公共代理)";

    const cs = $("#meCacheState");
    if (cs) {
      if (!HAS_IDB) {
        cs.textContent = "离线归档不可用(浏览器限制),仍可在线使用";
      } else {
        cs.textContent = "统计中…";
        (async () => {
          const dates = (await safeIdb(idb.keys("days"))) || [];
          const persisted = await safeIdb(idb.get("meta", "persistGranted"));
          let sizeStr = "";
          try {
            if (navigator.storage && navigator.storage.estimate) {
              const est = await navigator.storage.estimate();
              if (est && est.usage) sizeStr = ` · 约 ${(est.usage / 1048576).toFixed(1)} MB`;
            }
          } catch {}
          cs.textContent = `已离线缓存 ${dates.length} 天历史${sizeStr}${persisted ? " · 持久化已开启" : ""}`;
        })();
      }
    }

    const seg = $("#themeSeg");
    if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("seg-on", b.dataset.themePref === themePref));

    // 关注管理:已关注游戏(点 ✕ 取消)+ 来源开关
    const fg = $("#meFollowGames");
    if (fg)
      fg.innerHTML = followGames.size
        ? [...followGames].map(([k, name]) => `<span class="src-pill follow-chip" data-unfollow-game="${esc(k)}">《${esc(name)}》 ✕</span>`).join("")
        : `<span class="me-empty">还没关注游戏 · 在快讯页点开某游戏后点「★ 关注」</span>`;
    const fs = $("#meFollowSources");
    if (fs) {
      const allSrc = stats ? Object.keys(stats) : ["游民星空", "3DM", "游侠网", "A9VG", "机核", "游研社", "触乐", "17173", "indienova", "IGN", "GameSpot", "PC Gamer", "Push Square", "Nintendo Life", "Steam"];
      fs.innerHTML = allSrc
        .map((s) => `<span class="src-pill src-toggle${followSources.has(s) ? " followed" : ""}" data-follow-src="${esc(s)}">${followSources.has(s) ? "★ " : ""}${esc(s)}</span>`)
        .join("");
    }
  }

  function saveWorker() {
    const v = ($("#meWorker").value || "").trim().replace(/\s/g, "");
    if (v && !/^https:\/\/.+/.test(v)) {
      toast("请填写完整的 https:// 网址");
      return;
    }
    WORKER_PROXY = v;
    store.set(WORKER_KEY, v);
    PROXIES = proxyChain(); // 重建代理链,立即生效
    renderMe();
    renderAll();
    toast(v ? "图片代理已启用" : "已清除,恢复默认");
  }

  function resolvePick(p) {
    return D.news.find(
      (n) => (n.url && n.url === p.key) || (n.title || "").slice(0, 18) === p.key || n.title === p.title
    );
  }

  function renderDigest() {
    const el = $("#digestCard");
    const d = D.digest;
    if (!d || !d.picks || !d.picks.length) {
      el.innerHTML = "";
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    const rows = d.picks
      .map((p) => {
        const n = resolvePick(p);
        return `<button class="digest-pick"${n ? ` data-id="${n.id}"` : ""}><b>${esc(p.title)}</b><span>${esc(p.why)}</span></button>`;
      })
      .join("");
    el.innerHTML =
      `<div class="digest-head"><span class="digest-tag">✦ AI 主编</span><span class="digest-date">${esc(d.date || "")}</span></div>` +
      (d.overview ? `<p class="digest-overview">${esc(d.overview)}</p>` : "") +
      `<div class="digest-label">今天值得读</div>${rows}`;
  }

  function renderAll() {
    renderHero();
    renderFeatured();
    renderChips();
    renderDigest();
    renderTopics();
    renderFeed();
    renderFlash();
  }

  const findNews = (id) =>
    D.news.find((n) => n.id === id) ||
    history.flatMap((g) => g.items).find((n) => n.id === id) ||
    favViewItems.find((n) => n.id === id);

  /* ---------- 历史新闻:滑到底部加载更早(archive/) ---------- */

  let archiveDates = null;
  let riverOrder = [];
  const loadedDates = new Set();
  const history = [];
  let historyLoading = false;
  let historyIdSeq = 100000;

  async function loadMoreHistory() {
    if (historyLoading) return;
    historyLoading = true;
    let errored = false;
    const more = $("#feedMore");
    try {
      if (archiveDates === null) {
        try {
          const r = await fetch("archive/index.json", { cache: "no-store" });
          archiveDates = r.ok ? await r.json() : [];
          if (archiveDates.length) safeIdb(idb.put("meta", archiveDates, "archiveIndex")); // 供离线枚举
        } catch {
          // 离线:用 IDB 里缓存过的归档索引兜底
          archiveDates = (await safeIdb(idb.get("meta", "archiveIndex"))) || [];
        }
      }
      while (true) {
        const next = (archiveDates || []).find((d) => !loadedDates.has(d));
        if (!next) {
          more.textContent = archiveDates && archiveDates.length ? "没有更早的新闻了" : "暂无历史归档";
          return;
        }
        more.textContent = "加载更早的新闻…";
        let dayItems = null;
        const cachedDay = await safeIdb(idb.get("days", next));
        if (cachedDay && Array.isArray(cachedDay.items)) {
          dayItems = cachedDay.items; // 命中 IDB:离线可用 + 免重复下载
          touchDay(next);
        } else if (!navigator.onLine) {
          // 离线且未缓存该天:不永久标记 loadedDates(否则联网后本会话再也补不回这些天),
          // 停下给诚实提示;errored 置真避免 rAF 自动续拉空转,联网后用户下滑会再触发
          more.textContent = "离线中 · 更早的新闻需联网后加载";
          errored = true;
          return;
        } else {
          const r = await fetch(`archive/${next}.json`);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const day = await r.json();
          dayItems = day.items || [];
          safeIdb(idb.put("days", { date: next, items: dayItems, savedAt: Date.now(), lastAccess: Date.now(), bytes: approxBytes(dayItems) }));
          maybePrune();
        }
        loadedDates.add(next);
        const windowKeys = new Set(D.news.map(itemKey));
        const items = dayItems.map((n) => normalizeItem(n, ++historyIdSeq));
        history.push({ date: next, items });
        if (items.some((n) => !windowKeys.has(itemKey(n)))) {
          rebuildThreads(); // 历史增长 → 脉络可能新增进展
          renderFeedKeepAnchor();
          more.textContent = "继续下滑加载更早";
          break;
        }
      }
    } catch {
      more.textContent = "加载失败,继续下滑重试";
      errored = true; // 出错就不自动重试,改由用户真正再下滑(IntersectionObserver)触发,避免空转死循环
    } finally {
      historyLoading = false;
    }
    if (errored) return;
    requestAnimationFrame(() => {
      const rect = more.getBoundingClientRect();
      if (rect.top < window.innerHeight + 400 && (archiveDates || []).some((d) => !loadedDates.has(d))) {
        loadMoreHistory();
      }
    });
  }

  /* ---------- 详情页即时全文(条目无全文时现场抓原文解析) ---------- */

  const decodeBox = document.createElement("textarea");
  function clientStrip(s) {
    decodeBox.innerHTML = (s || "").replace(/<[^>]+>/g, " ");
    return decodeBox.value.replace(/\s+/g, " ").trim();
  }

  const CLIENT_BOILER = /(本文由游民星空|更多相关资讯请关注|转载请注明|责任编辑|关注游民星空|点击进入专题|友情提示|点此前往|游民星空APP|随时掌握游戏情报|出版物经营许可证|京ICP备|京公网安备|人喜欢$|猜你喜欢|点此进入|点击查看更多|怀旧频道|>>>|<<<|\.text\(\)|gb-final-)/;

  function htmlBlocksClient(html) {
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
    const blocks = [];
    let textLen = 0,
      imgs = 0;
    const re = /<(p|h[23])[^>]*>([\s\S]*?)<\/\1>|<img[^>]+src="([^"]+)"[^>]*\/?>/gi;
    let m;
    while ((m = re.exec(html)) && blocks.length < 60) {
      if (m[3]) {
        if (imgs < 12 && /^https?:\/\//.test(m[3]) && !/qrcode|avatar|author_cover|static\/pages|loading\.gif|logo/i.test(m[3])) {
          imgs++;
          blocks.push({ t: "img", v: m[3] });
        }
      } else {
        const inner = m[2];
        for (const im of inner.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
          if (imgs < 12 && /^https?:\/\//.test(im[1])) {
            imgs++;
            blocks.push({ t: "img", v: im[1] });
          }
        }
        const v = clientStrip(inner);
        if (v && !CLIENT_BOILER.test(v)) {
          textLen += v.length;
          blocks.push({ t: m[1].toLowerCase() === "p" ? "p" : "h", v });
        }
      }
    }
    return textLen >= 50 ? blocks : null;
  }

  const CLIENT_CONTAINERS = [
    { host: "17173.com", rx: /<div class="gb-final-mod-article[^"]*"[^>]*>([\s\S]*?)(?:gb-final-pn|gb-final-mod-recommend|猜你喜欢|class="mod-side-qrcode|class="mod-share|免责声明|$)/ },
    { host: "gamersky.com", rx: /<div class="Mid2L_con">([\s\S]*?)(?:<span id="pe100_page_contentpage|<!--文章内容导航|<a class="diggBtn|$)/ },
    { host: "3dmgame.com", rx: /<div class="news_warp_center">([\s\S]*?)(?:class="bq|$)/ },
    { host: "yystv.cn", rx: /<div class="doc-content[^"]*"[^>]*>([\s\S]*?)(?:class="article-links-container|class="qrcode-block|class="doc-share|$)/ },
    { host: "chuapp.com", rx: /<div class="the-content[^"]*"[^>]*>([\s\S]*?)(?:<!--end-->|<!--评论start|相关文章|$)/ },
  ];

  const canFetchFullText = (n) =>
    !!n.url && (/gcores\.com\/articles\/\d+/.test(n.url) || CLIENT_CONTAINERS.some((c) => n.url.includes(c.host)));

  // 从当日归档文件取全文(news.json 瘦身后,较旧条目的全文存在归档里)
  const dayFileCache = new Map(); // day → Promise<items>
  function contentFromArchive(n) {
    if (!n.ts) return Promise.resolve(null);
    const day = new Date(n.ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (!dayFileCache.has(day)) {
      dayFileCache.set(
        day,
        (async () => {
          // 先读 IDB(离线可用 + 免重复下载),命中即返回当天 items
          const cached = await safeIdb(idb.get("days", day));
          if (cached && Array.isArray(cached.items) && cached.items.length) {
            touchDay(day);
            return cached.items;
          }
          try {
            const r = await fetch(`archive/${day}.json`, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) { dayFileCache.delete(day); return []; }
            const items = (await r.json()).items || [];
            if (items.length) safeIdb(idb.put("days", { date: day, items, savedAt: Date.now(), lastAccess: Date.now(), bytes: approxBytes(items) }));
            return items;
          } catch {
            dayFileCache.delete(day); // 失败不缓存,允许重试
            return [];
          }
        })()
      );
    }
    return dayFileCache.get(day).then((items) => {
      const hit = items.find((it) => (it.url && it.url === n.url) || it.title === n.title);
      return hit && hit.content ? hit.content : null;
    });
  }

  async function fetchFullText(n) {
    const gc = (n.url || "").match(/gcores\.com\/articles\/(\d+)/);
    if (gc) {
      const j = JSON.parse(await proxyFetch(`https://www.gcores.com/gapi/v1/articles/${gc[1]}`));
      const content = JSON.parse(j.data.attributes.content);
      const blocks = [];
      for (const b of content.blocks || []) {
        if (b.type === "atomic") {
          for (const er of b.entityRanges || []) {
            const ent = content.entityMap?.[String(er.key)];
            const p = ent && ent.type === "IMAGE" && ent.data && (ent.data.path || ent.data.src);
            if (p) blocks.push({ t: "img", v: /^https?:/.test(p) ? p : `https://image.gcores.com/${p}` });
          }
        } else if (b.text?.trim() && b.text.trim() !== "-") {
          blocks.push({ t: /header/.test(b.type) ? "h" : "p", v: b.text.trim() });
        }
      }
      return blocks.length ? blocks : null;
    }
    const c = CLIENT_CONTAINERS.find((c) => (n.url || "").includes(c.host));
    if (!c) return null;
    const html = await proxyFetch(n.url);
    const m = html.match(c.rx);
    return m ? htmlBlocksClient(m[1]) : null;
  }

  /* ---------- 文章详情 ---------- */

  // 阅读时长:中文按 ~350 字/分,英文按 ~200 词/分,取整至少 1 分钟
  function readMinutes(n) {
    let cjk = 0, en = 0;
    const add = (s) => {
      if (!s) return;
      cjk += (s.match(/[一-鿿]/g) || []).length;
      en += (s.match(/[a-zA-Z]+/g) || []).length;
    };
    (Array.isArray(n.blocks) ? n.blocks : []).forEach((b) => { if (b.t !== "img") add(b.v); });
    return Math.max(1, Math.round(cjk / 350 + en / 200));
  }

  function renderDetailBody(n) {
    if (n.blocks) {
      const imgBlocks = n.blocks.filter((b) => b.t === "img");
      const textBlocks = n.blocks.filter((b) => b.t !== "img");
      const rt = `<p class="read-time">约 ${readMinutes(n)} 分钟读完${imgBlocks.length ? ` · ${imgBlocks.length} 图` : ""}</p>`;
      const renderBlock = (b) =>
        b.t === "img" ? imgTag("detail-img", b.v, "detail", "") : b.t === "h" ? `<h3 class="detail-h">${esc(b.v)}</h3>` : `<p>${esc(b.v)}</p>`;
      // 图集(图多文少:≥3 图且正文段落 ≤2):横滑轮播 + 1/N 计数,文字附下方;否则照常竖排
      if (imgBlocks.length >= 3 && textBlocks.length <= 2) {
        const slides = imgBlocks
          .map((b) => `<div class="gallery-slide">${imgTag("detail-img gallery-img", b.v, "detail", "")}</div>`)
          .join("");
        // 同一篇被重渲(刷新/注水补全)时,保留图集横向滚动位置,别跳回第一张;换文章则归零
        if (galTrackKey !== itemKey(n)) { galTrackKey = itemKey(n); galTrackScroll = 0; }
        const keepScroll = galTrackScroll;
        const startN = keepScroll ? Math.min(imgBlocks.length, Math.round(keepScroll / Math.max(1, $("#detailContent").clientWidth || 1)) + 1) : 1;
        $("#detailContent").innerHTML =
          rt +
          `<div class="gallery"><div class="gallery-track" id="galleryTrack">${slides}</div>` +
          `<div class="gallery-count" id="galleryCount">${startN} / ${imgBlocks.length}</div></div>` +
          textBlocks.map(renderBlock).join("");
        const track = $("#galleryTrack");
        if (track) {
          if (keepScroll) track.scrollLeft = keepScroll;
          track.addEventListener(
            "scroll",
            () => {
              galTrackScroll = track.scrollLeft;
              const i = Math.min(imgBlocks.length, Math.round(track.scrollLeft / Math.max(1, track.clientWidth)) + 1);
              const c = $("#galleryCount");
              if (c) c.textContent = `${i} / ${imgBlocks.length}`;
            },
            { passive: true }
          );
        }
      } else {
        $("#detailContent").innerHTML = rt + n.blocks.map(renderBlock).join("");
      }
      $("#detailLink").innerHTML = n.url
        ? `<a class="origin-link" href="${esc(n.url)}" target="_blank" rel="noopener">内容整理自 ${esc(n.source)} · 查看原文 ↗</a>`
        : "";
    } else {
      $("#detailContent").innerHTML = n.content.map((p) => `<p>${esc(p)}</p>`).join("");
      $("#detailLink").innerHTML = n.url
        ? `<a class="src-link" href="${esc(n.url)}" target="_blank" rel="noopener">${n.isVideo ? "▶ 观看视频" : "↗ 阅读原文"}<span>${esc(n.source)}</span></a>`
        : "";
    }
    // "各家怎么说":多源同报事件,列出其它媒体的报道入口
    const others = (n.others || []).filter((o) => o.url !== n.url);
    $("#detailSources").innerHTML = others.length
      ? `<div class="src-panel"><div class="src-panel-h">各家怎么说 · ${others.length + 1} 源同报</div>` +
        `<a class="src-row src-row-cur"><span class="src-name">${esc(n.source)}</span><span class="src-t">${esc(n.title)}</span></a>` +
        others
          .map(
            (o) =>
              `<a class="src-row" href="${esc(o.url)}" target="_blank" rel="noopener"><span class="src-name">${esc(o.source)}</span><span class="src-t">${esc(o.title)}</span></a>`
          )
          .join("") +
        `</div>`
      : "";
    renderDetailThread(n); // 事件脉络面板(随 body 一起渲染,覆盖所有重渲路径)
    armImgWatchdogs(); // 正文/封面图挂起也能兜底降级,不永久闪骨架
  }

  // 全文三级管道(当日归档 → 现场抓原文 → 摘要兜底);抽成独立函数以便"重试"复用
  async function loadFullText(n, wantId) {
    $("#detailLoading")?.remove();
    $("#detailContent").insertAdjacentHTML(
      "beforeend",
      '<p class="detail-loading" id="detailLoading"><svg class="load-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/></svg>正在加载全文…</p>'
    );
    let blocks = null;
    if (n.fullArchived) { try { blocks = await contentFromArchive(n); } catch {} }
    if (!blocks && canFetchFullText(n)) { try { blocks = await fetchFullText(n); } catch {} }
    if (currentDetailId !== wantId) return; // 已切走
    const sb = sanitizeBlocks(blocks);
    if (sb) { n.blocks = sb; renderDetailBody(n); return; }
    const el = $("#detailLoading");
    if (!el) return;
    el.classList.add("detail-loadfail");
    // 离线时不再承诺"15 分钟自动补全"(bot 更新到不了本机),文案诚实 + 提供重试
    el.innerHTML =
      (!navigator.onLine
        ? "离线中 · 此篇全文尚未缓存,联网后可重试"
        : "原文暂时取不到 · 全文会在 15 分钟内随自动更新补全,可先看摘要或跳转原文") +
      ' <button class="detail-retry" id="detailRetry">重试</button>';
  }

  function openDetail(id) {
    const n = findNews(id);
    if (!n) return;
    stopSpeak(); // 切换文章先停掉上一篇的朗读
    currentDetailId = id;
    currentDetailKey = itemKey(n);
    const cover = $("#detailCover");
    cover.style.cssText = coverStyle(n.cover);
    // 封面用真实 <img> + 兜底链(CSS background 既不吃 referrerpolicy 也无法 onerror 重试)
    cover.querySelector(".detail-cover-img")?.remove();
    if (n.image) {
      cover.insertAdjacentHTML("afterbegin", imgTag("detail-cover-img", n.image, "cover", ""));
    }
    $("#detailTag").textContent = n.category;
    $("#detailTitle").textContent = n.title;
    $("#detailTitleEn").textContent = n.titleEn || "";
    $("#detailTitleEn").classList.toggle("hidden", !n.titleEn);
    const followName = (n.title.match(/《([^》]+)》/) || [])[1] || "";
    const followedGame = followName && followGames.has(threadKeyOf(normT(followName)));
    $("#detailMeta").innerHTML =
      `<span>${esc(n.source)}</span><span>${esc(n.time)}</span>` +
      (n.official ? `<span class="hot-meta">官方公告</span>` : "") +
      (n.hot > 1 ? `<span class="hot-meta">🔥 ${n.hotSources ? esc(n.hotSources.join("、")) : n.hot + " 家媒体"}同报</span>` : "") +
      (followName ? `<span class="meta-follow${followedGame ? " on" : ""}" data-follow-game="${esc(followName)}">${followedGame ? "★ 已关注" : "☆ 关注"}《${esc(followName)}》</span>` : "");
    renderDetailBody(n);
    // 无全文时走三级管道(可重试)
    if (!n.blocks && (n.fullArchived || canFetchFullText(n))) loadFullText(n, id);
    // 下一篇(按当前信息流顺序)
    const idx = riverOrder.findIndex((r) => r.id === id);
    const next = idx >= 0 ? riverOrder[idx + 1] : null;
    $("#detailNext").innerHTML = next
      ? `<button class="next-card" data-id="${next.id}"><span>下一篇</span><b>${esc(next.title)}</b></button>`
      : "";
    $("#actLike").classList.remove("acted");
    $("#actFav").classList.toggle("acted", isFaved(n));
    $("#actLater").classList.toggle("acted", isLater(n));
    // 标记已读
    const key = itemKey(n);
    if (!readSet.has(key)) {
      readSet.add(key);
      persistRead();
      $$(`.news-item[data-id="${id}"]`).forEach((el) => el.classList.add("is-read"));
    }
    const detail = $("#detail");
    detail.classList.remove("hidden");
    detail.scrollTop = 0;
  }

  function closeDetail(animate = true) {
    stopSpeak(); // 关闭详情停掉朗读
    const detail = $("#detail");
    if (!animate) {
      detail.classList.add("hidden");
      return;
    }
    detail.classList.add("detail-out");
    setTimeout(() => {
      detail.classList.add("hidden");
      detail.classList.remove("detail-out");
    }, 200);
  }

  /* ---------- 收藏 / 分享 ---------- */

  const isFaved = (n) => getFavs().some((f) => itemKey(f) === itemKey(n));

  // 存进收藏/稍后读用的精简快照
  const snapshotItem = (n) => ({
    title: n.title, titleEn: n.titleEn, summary: n.summary, source: n.source, url: n.url,
    image: n.image, isVideo: n.isVideo, ts: n.ts, category: n.category, content: n.blocks,
    fullArchived: n.fullArchived || undefined,
  });

  function toggleFav(id) {
    const n = findNews(id);
    if (!n) return;
    let favs = getFavs();
    const key = itemKey(n);
    if (favs.some((f) => itemKey(f) === key)) {
      favs = favs.filter((f) => itemKey(f) !== key);
      toast("已取消收藏");
    } else {
      favs.push(snapshotItem(n));
      favs = favs.slice(-100);
      toast("已收藏,可在「收藏」页查看");
    }
    store.set(FAV_KEY, favs);
    $("#actFav").classList.toggle("acted", favs.some((f) => itemKey(f) === key));
    renderHero();
    if (!$("#view-favs").classList.contains("hidden")) renderFavs();
  }

  /* ---------- 稍后读 ---------- */
  const getLater = () => store.get(LATER_KEY, []);
  const isLater = (n) => getLater().some((f) => itemKey(f) === itemKey(n));
  function toggleLater(id) {
    const n = findNews(id);
    if (!n) return;
    let list = getLater();
    const key = itemKey(n);
    if (list.some((f) => itemKey(f) === key)) {
      list = list.filter((f) => itemKey(f) !== key);
      toast("已移出稍后读");
    } else {
      list.push(snapshotItem(n));
      list = list.slice(-100);
      toast("已加入稍后读");
    }
    store.set(LATER_KEY, list);
    $("#actLater").classList.toggle("acted", list.some((f) => itemKey(f) === key));
    if (!$("#view-favs").classList.contains("hidden")) renderFavs();
  }

  // 纯链接分享(图卡不可用时的兜底)
  function shareLink(n) {
    const url = n.url || location.href;
    if (navigator.share) navigator.share({ title: n.title, url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(`${n.title} ${url}`).then(() => toast("链接已复制")).catch(() => {});
    else toast("此设备不支持分享");
  }

  // canvas 文字按宽换行(CJK 无空格,逐字测量);超出末行省略号
  function wrapLines(ctx, text, maxW, maxLines) {
    const chars = [...(text || "")];
    const out = [];
    let cur = "";
    for (const ch of chars) {
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        out.push(cur);
        cur = ch;
        if (out.length === maxLines) { out[maxLines - 1] = out[maxLines - 1].slice(0, -1) + "…"; return out; }
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out.slice(0, maxLines);
  }

  // 生成一张曜石黑金分享图卡(不引用远程图片以免污染 canvas);能分享文件就分享,否则进灯箱可长按保存
  async function shareCard(n) {
    try {
      const W = 1080, H = 1350;
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d");
      const SANS = '-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      const SERIF = '"Songti SC","Noto Serif SC","STSong",Georgia,serif';

      let g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#1A1A20"); g.addColorStop(1, "#0B0B0E");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

      const c = n.cover || {};
      g = ctx.createLinearGradient(0, 0, W, 300);
      g.addColorStop(0, c.c1 || "#3D5BF5"); g.addColorStop(1, c.c2 || "#1B2A8A");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, 300);
      ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.font = `700 36px ${SANS}`;
      ctx.fillText(n.category || "业界", 72, 132);
      ctx.fillStyle = "rgba(255,255,255,0.72)"; ctx.font = `500 30px ${SANS}`;
      ctx.fillText((n.source || "") + (n.hot > 1 ? "  · 🔥 多源同报" : ""), 72, 184);

      ctx.fillStyle = "#F4F1EA"; ctx.font = `700 66px ${SERIF}`;
      let y = 470;
      for (const line of wrapLines(ctx, n.title || "", W - 144, 5)) { ctx.fillText(line, 72, y); y += 90; }

      if (n.summary) {
        ctx.fillStyle = "#9C988D"; ctx.font = `400 34px ${SANS}`;
        y += 18;
        for (const line of wrapLines(ctx, n.summary, W - 144, 3)) { ctx.fillText(line, 72, y); y += 52; }
      }

      ctx.strokeStyle = "#C8A96A"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(72, H - 176); ctx.lineTo(W - 72, H - 176); ctx.stroke();
      ctx.fillStyle = "#C8A96A"; ctx.font = `700 46px ${SERIF}`;
      ctx.fillText("电玩日报", 72, H - 108);
      ctx.fillStyle = "#74716A"; ctx.font = `400 30px ${SANS}`; ctx.textAlign = "right";
      const dateStr = n.ts ? dayKeyOf(n.ts).replace(/-/g, ".") : "";
      ctx.fillText(`每日游戏速递${dateStr ? " · " + dateStr : ""}`, W - 72, H - 108);
      ctx.textAlign = "left";

      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      const file = blob && new File([blob], "电玩日报.png", { type: "image/png" });
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: `${n.title}${n.url ? "\n" + n.url : ""}` });
      } else {
        $("#lightboxImg").src = cv.toDataURL("image/png");
        $("#lightbox").classList.remove("hidden");
        toast("长按图片即可保存分享卡");
      }
    } catch {
      shareLink(n); // canvas/分享失败 → 退回链接分享
    }
  }

  async function shareNews(id) {
    const n = findNews(id);
    if (n) await shareCard(n);
  }

  /* ---------- 朗读(TTS,系统 speechSynthesis,免费免密钥)---------- */
  let speaking = false;
  function stopSpeak() {
    try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch {}
    speaking = false;
    const b = $("#actSpeak");
    if (b) { b.classList.remove("acted"); b.querySelector("span").textContent = "朗读"; }
  }
  function toggleSpeak(id) {
    if (!("speechSynthesis" in window)) { toast("此设备不支持朗读"); return; }
    if (speaking) { stopSpeak(); return; }
    const n = findNews(id);
    if (!n) return;
    const parts = [n.title];
    if (Array.isArray(n.blocks)) n.blocks.forEach((b) => { if (b.t === "p" || b.t === "h") parts.push(b.v); });
    else if (n.summary) parts.push(n.summary);
    const u = new SpeechSynthesisUtterance(parts.join("。 ").slice(0, 4000));
    u.lang = "zh-CN"; u.rate = 1;
    u.onend = stopSpeak; u.onerror = stopSpeak;
    try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { toast("朗读启动失败"); return; }
    speaking = true;
    const b = $("#actSpeak");
    if (b) { b.classList.add("acted"); b.querySelector("span").textContent = "停止"; }
  }

  /* ---------- 标签栏 ---------- */

  let activeTab = "home";
  const tabScroll = {}; // 各 tab 的滚动位置,切走记住、切回还原
  function switchTab(tab) {
    if (tab === activeTab) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    tabScroll[activeTab] = window.scrollY;
    activeTab = tab;
    $$(".tab").forEach((b) => b.classList.toggle("tab-active", b.dataset.tab === tab));
    $("#view-home").classList.toggle("hidden", tab !== "home");
    $("#view-flash").classList.toggle("hidden", tab !== "flash");
    $("#view-favs").classList.toggle("hidden", tab !== "favs");
    $("#view-me").classList.toggle("hidden", tab !== "me");
    if (tab === "flash") renderFlash(); // 重算本周风向(历史可能已增长)
    if (tab === "favs") renderFavs();
    if (tab === "me") renderMe();
    window.scrollTo(0, tabScroll[tab] || 0);
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    $("#chipsRow").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      activeCategory = chip.dataset.cat;
      clearSearchFilter();
      renderChips();
      renderFeed();
    });

    document.body.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      // 正文图片 → 灯箱大图
      if (e.target.classList.contains("detail-img")) {
        const orig = e.target.dataset.orig;
        $("#lightboxImg").src = orig ? imgSrc(orig, "full") : e.target.src;
        $("#lightbox").classList.remove("hidden");
        return;
      }
      // 详情页全文加载失败后的「重试」
      if (e.target.closest("#detailRetry")) {
        const cur = findNews(currentDetailId);
        if (cur) loadFullText(cur, currentDetailId);
        return;
      }
      // 详情页 meta 里的「☆ 关注《游戏》」pill:就地关注 + 即时更新按钮态
      const fg = e.target.closest("[data-follow-game]");
      if (fg) {
        toggleFollowGame(fg.dataset.followGame);
        const on = followGames.has(threadKeyOf(normT(fg.dataset.followGame)));
        fg.classList.toggle("on", on);
        fg.textContent = `${on ? "★ 已关注" : "☆ 关注"}《${fg.dataset.followGame}》`;
        return;
      }
      const card = e.target.closest("[data-id]");
      if (card && !e.target.closest(".chip") && !e.target.closest(".saved-rm")) openDetail(Number(card.dataset.id));
    });

    // 周度风向「高频游戏」胶囊 → 回首页按该游戏筛选(热议行带 data-id,由上面的 body 委托接管)
    $("#weeklyReport").addEventListener("click", (e) => {
      const chip = e.target.closest(".week-game[data-game]");
      if (chip) searchGame(chip.dataset.game);
    });

    // 发售表行 → 回首页按该游戏筛选
    $("#releaseCal").addEventListener("click", (e) => {
      const row = e.target.closest(".rel-row[data-game]");
      if (row) searchGame(row.dataset.game);
    });

    // 事件脉络的进展行(<a data-key>,无 href,被上面的 body 委托忽略),按 itemKey 解析并优先窗口副本
    $("#detailThread").addEventListener("click", (e) => {
      const row = e.target.closest(".src-row[data-key]");
      if (!row) return;
      const key = row.dataset.key;
      const live = D.news.find((x) => itemKey(x) === key) || history.flatMap((g) => g.items).find((x) => itemKey(x) === key);
      if (live) openDetail(live.id);
    });

    $("#lightbox").addEventListener("click", () => {
      $("#lightbox").classList.add("hidden");
      $("#lightboxImg").src = "";
    });

    $("#detailBack").addEventListener("click", (e) => {
      e.stopPropagation();
      closeDetail();
    });

    $("#tabbar").addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      if (tab) switchTab(tab.dataset.tab);
    });

    $$(".refresh-btn").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        refresh(false);
      })
    );

    $("#actLike").addEventListener("click", (e) => {
      e.stopPropagation();
      e.currentTarget.classList.toggle("acted");
      toast(e.currentTarget.classList.contains("acted") ? "已点赞" : "已取消");
    });
    $("#actFav").addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentDetailId != null) toggleFav(currentDetailId);
    });
    $("#actLater").addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentDetailId != null) toggleLater(currentDetailId);
    });
    $("#actSpeak").addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentDetailId != null) toggleSpeak(currentDetailId);
    });
    $("#actShare").addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentDetailId != null) shareNews(currentDetailId);
    });

    $("#themeSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-theme-pref]");
      if (b) setTheme(b.dataset.themePref);
    });

    // 搜索
    $("#searchBtn").addEventListener("click", () => {
      const row = $("#searchRow");
      row.classList.toggle("hidden");
      if (!row.classList.contains("hidden")) $("#searchInput").focus();
      else {
        searchQuery = "";
        searchGameName = null;
        $("#searchInput").value = "";
        renderSearchFollow();
        renderFeed();
      }
    });
    let searchTimer = null;
    $("#searchInput").addEventListener("input", (e) => {
      searchGameName = null; // 手动输入不再是"按游戏筛选",隐藏关注按钮
      renderSearchFollow();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = e.target.value.trim();
        renderFeed();
      }, 150);
    });
    $("#searchClear").addEventListener("click", () => {
      searchQuery = "";
      searchGameName = null;
      $("#searchInput").value = "";
      $("#searchRow").classList.add("hidden");
      renderSearchFollow();
      renderFeed();
    });
    $("#searchFollow").addEventListener("click", () => {
      if (searchGameName) toggleFollowGame(searchGameName);
    });

    // 关注管理:取消关注游戏 / 切换关注来源
    $("#meFollowGames").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-unfollow-game]");
      if (chip) unfollowGameKey(chip.dataset.unfollowGame);
    });
    $("#meFollowSources").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-follow-src]");
      if (chip) toggleFollowSource(chip.dataset.followSrc);
    });

    // 收藏页:收藏/稍后读切换 + 搜索 + 分组 + 单条移除
    $("#favSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-fav-mode]");
      if (!b) return;
      favMode = b.dataset.favMode;
      favGroup = "全部";
      favSearch = "";
      $("#favSearch").value = "";
      renderFavs();
    });
    let favTimer = null;
    $("#favSearch").addEventListener("input", (e) => {
      clearTimeout(favTimer);
      favTimer = setTimeout(() => { favSearch = e.target.value.trim(); renderFavs(); }, 150);
    });
    $("#favChips").addEventListener("click", (e) => {
      const c = e.target.closest("[data-fav-group]");
      if (c) { favGroup = c.dataset.favGroup; renderFavs(); }
    });
    $("#favsList").addEventListener("click", (e) => {
      const rm = e.target.closest(".saved-rm[data-rm-key]");
      if (rm) { e.stopPropagation(); removeSaved(rm.dataset.rmKey); }
    });

    $("#meWorkerSave").addEventListener("click", saveWorker);

    const cc = $("#meCacheClear");
    if (cc)
      cc.addEventListener("click", async () => {
        await safeIdb(idb.clearAll());
        store.set(CACHE_KEY, null); // 清掉瘦身镜像(下次启动回到演示兜底直至刷新)
        closeDetail(false); // 关掉可能开着的详情页,避免显示已清数据
        history.length = 0; // 丢掉内存里的历史,避免显示已清的数据
        loadedDates.clear();
        touchedDays.clear();
        dayFileCache.clear();
        rebuildThreads(); // 历史已清,脉络随之重算(仅剩窗口数据)
        renderFeed(); // 重渲信息流,移除已清的历史条目
        toast("离线缓存已清除");
        renderMe();
      });
  }

  /* ---------- iOS 手势:详情页任意位置右滑返回 ---------- */

  function bindSwipeBack() {
    const detail = $("#detail");
    let sx = 0, sy = 0, dx = 0, mode = null;
    detail.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        sx = t.clientX;
        sy = t.clientY;
        dx = 0;
        // 起点在横滑图集里 → 标记为 scroll,把左右滑让给图集,不触发返回
        mode = e.target.closest(".gallery-track") ? "scroll" : null;
      },
      { passive: true }
    );
    detail.addEventListener(
      "touchmove",
      (e) => {
        if (mode === "scroll") return;
        const t = e.touches[0];
        const mx = t.clientX - sx;
        const my = t.clientY - sy;
        if (mode === null) {
          if (mx > 12 && mx > Math.abs(my) * 1.4) {
            mode = "swipe";
            detail.style.transition = "none";
          } else if (Math.abs(my) > 12 || mx < -12) {
            mode = "scroll";
            return;
          } else {
            return;
          }
        }
        dx = Math.max(0, mx);
        detail.style.transform = `translateX(calc(-50% + ${dx}px))`;
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );
    detail.addEventListener("touchend", () => {
      const wasSwipe = mode === "swipe";
      mode = null;
      if (!wasSwipe) return;
      detail.style.transition = "transform 0.22s ease";
      if (dx > 90) {
        detail.style.transform = "translateX(calc(-50% + 105%))";
        setTimeout(() => {
          closeDetail(false);
          detail.style.transition = "";
          detail.style.transform = "";
        }, 220);
      } else {
        detail.style.transform = "";
        setTimeout(() => (detail.style.transition = ""), 240);
      }
    });
  }

  /* ---------- 手势:主界面左右滑切换分区 ---------- */

  function switchCategory(cat, dir) {
    if (cat === activeCategory) return;
    activeCategory = cat;
    clearSearchFilter();
    renderChips();
    const fl = $("#feedList");
    fl.classList.remove("slide-l", "slide-r");
    void fl.offsetWidth; // 重置动画
    renderFeed();
    fl.classList.add(dir === "left" ? "slide-l" : "slide-r");
    // 视口若深入旧列表,回到资讯区顶部
    const feedTop = document.querySelector(".feed").getBoundingClientRect().top + window.scrollY - 64;
    if (window.scrollY > feedTop) window.scrollTo({ top: Math.max(0, feedTop) });
    toast(`「${cat}」`);
  }

  function bindCategorySwipe() {
    const view = $("#view-home");
    let sx = 0, sy = 0, mode = null;
    view.addEventListener(
      "touchstart",
      (e) => {
        // 头条轮播与分类胶囊本身横向滚动,不参与切区手势
        if (e.target.closest(".shelf-scroll") || e.target.closest(".chips")) {
          mode = "skip";
          return;
        }
        const t = e.touches[0];
        sx = t.clientX;
        sy = t.clientY;
        mode = null;
      },
      { passive: true }
    );
    view.addEventListener(
      "touchmove",
      (e) => {
        if (mode) return;
        const t = e.touches[0];
        const mx = t.clientX - sx;
        const my = t.clientY - sy;
        if (Math.abs(mx) > 16 && Math.abs(mx) > Math.abs(my) * 1.6) mode = mx < 0 ? "left" : "right";
        else if (Math.abs(my) > 16) mode = "skip";
      },
      { passive: true }
    );
    view.addEventListener("touchend", () => {
      if (mode === "left" || mode === "right") {
        const idx = CATEGORIES.indexOf(activeCategory);
        const next = mode === "left" ? Math.min(CATEGORIES.length - 1, idx + 1) : Math.max(0, idx - 1);
        switchCategory(CATEGORIES[next], mode);
      }
      mode = null;
    });
  }

  /* ---------- iOS 手势:列表下拉刷新 ---------- */

  function bindPullRefresh() {
    const ptr = $("#ptr");
    const icon = ptr.querySelector("svg");
    const TRIGGER = 34;
    let sy = null, sx = 0, dist = 0, pulling = false;

    document.addEventListener(
      "touchstart",
      (e) => {
        const detailOpen = !$("#detail").classList.contains("hidden");
        if (window.scrollY <= 0 && !detailOpen && !refreshing) {
          sy = e.touches[0].clientY;
          sx = e.touches[0].clientX;
          dist = 0;
          pulling = false;
        } else {
          sy = null;
        }
      },
      { passive: true }
    );
    document.addEventListener(
      "touchmove",
      (e) => {
        if (sy == null || refreshing) return;
        const dy = e.touches[0].clientY - sy;
        const dxAbs = Math.abs(e.touches[0].clientX - sx);
        if (dy > 8 && dy > dxAbs * 1.5 && window.scrollY <= 0) {
          pulling = true;
          if (e.cancelable) e.preventDefault();
          dist = Math.min(dy * 0.42, 92);
          ptr.style.transition = "none";
          ptr.style.transform = `translate(-50%, ${dist}px)`;
          icon.style.transform = `rotate(${dist * 4}deg)`;
          ptr.classList.toggle("ptr-ready", dist >= TRIGGER);
        }
      },
      { passive: false }
    );
    document.addEventListener("touchend", async () => {
      if (sy == null) return;
      sy = null;
      if (!pulling) return;
      pulling = false;
      ptr.style.transition = "";
      if (dist >= TRIGGER) {
        ptr.classList.add("ptr-loading");
        ptr.style.transform = "translate(-50%, 52px)";
        await refresh(false);
        ptr.classList.remove("ptr-loading", "ptr-ready");
      } else {
        ptr.classList.remove("ptr-ready");
      }
      ptr.style.transform = "";
      icon.style.transform = "";
      dist = 0;
    });
  }

  /* ---------- PWA:离线缓存 + 版本轮询更新(不依赖 SW 事件,iOS 可靠) ---------- */

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  let updatePrompted = false;
  function showUpdatePrompt(remoteV) {
    if (updatePrompted) return;
    updatePrompted = true;
    const el = $("#toast");
    el.textContent = `发现新版本 v${remoteV} · 点此立即更新`;
    el.classList.remove("hidden");
    el.style.cursor = "pointer";
    el.addEventListener(
      "click",
      async () => {
        el.textContent = "更新中…";
        try {
          // 清空全部缓存,强制从网络取新版
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
          const reg = await navigator.serviceWorker?.getRegistration();
          await reg?.update();
        } catch {}
        location.reload();
      },
      { once: true }
    );
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add("hidden");
      updatePrompted = false; // 错过可再提示
    }, 15000);
  }

  async function checkForUpdate() {
    try {
      const txt = await fetch("sw.js", { cache: "no-store", signal: AbortSignal.timeout(8000) }).then((r) => r.text());
      const remote = Number(txt.match(/dianwan-v(\d+)/)?.[1] || 0);
      const local = Number(APP_BUILD.match(/v(\d+)/)?.[1] || 0);
      if (remote > local) showUpdatePrompt(remote);
    } catch {}
  }

  /* ---------- 启动后异步注水:从 IndexedDB 补全正文 + 预载离线历史(绝不阻塞/清空首屏) ---------- */

  async function hydrateFromIdb() {
    if (!HAS_IDB) return;
    // gen 记下本次注水代次;refresh 成功时会 ++renderGen,使下面的 gen===renderGen 失败 → 网络数据优先。
    // 真正防"旧盖新"的是 snap.generatedAt >= D.generatedAt 这条时间戳护栏,gen 只是省掉无谓的重渲。
    const gen = ++renderGen;
    const db = await idb.open();
    if (!db) return; // 纯 localStorage 模式(open 失败/超时)

    // 一次性迁移:旧版把完整快照(含正文)塞 localStorage 撑配额;搬进 IDB 后镜像瘦身。
    // 加 gen===renderGen:若期间已有 refresh 落地,它已写了更新的快照,迁移就别拿旧的覆盖
    try {
      const existing = await safeIdb(idb.get("snapshot", "current"));
      const lsCache = store.get(CACHE_KEY, null);
      if (!existing && lsCache && snapshotHasContent(lsCache) && gen === renderGen) {
        safeIdb(idb.put("snapshot", { ...lsCache, savedAt: Date.now(), schemaTag: SCHEMA }, "current"));
        store.set(CACHE_KEY, slimSnapshot(lsCache));
      }
    } catch {}

    // 1) 快照升级:仅当期间无 refresh 抢先(网络优先)、形状兼容、且比瘦身镜像多带正文
    const snap = await safeIdb(idb.get("snapshot", "current"));
    if (
      snap && snap.news && snap.news.length &&
      gen === renderGen &&
      (snap.schemaTag == null || snap.schemaTag === SCHEMA) &&
      snapshotHasContent(snap) &&
      (!D.generatedAt || !snap.generatedAt || snap.generatedAt >= D.generatedAt)
    ) {
      try {
        const snapSig = (snap.generatedAt || "") + "#" + snap.news.length;
        D = normalizeRemote(snap);
        rebuildThreads();
        // 仅当可见数据确有变化才重渲;与已渲相同(通常只是补了正文块)则跳过,避免整表重建+缩略图闪回
        if (snapSig !== shownSig) { shownSig = snapSig; renderAll(); }
        // 注水前若已打开某篇详情(那时还只有摘要),正文到了就地补全
        if (currentDetailId != null && !$("#detail").classList.contains("hidden")) {
          const upgraded = findNews(currentDetailId);
          if (upgraded && upgraded.blocks) renderDetailBody(upgraded);
        }
      } catch {}
    }

    // 2) 预载最近 N 天历史 → 离线时间线即时可见,且跨会话复用;更早的天随下滑按需从 IDB 取
    const dates = (await safeIdb(idb.keys("days"))) || [];
    if (dates.length) {
      let added = false;
      for (const date of [...dates].sort().reverse().slice(0, HYDRATE_MAX_DAYS)) {
        if (loadedDates.has(date)) continue;
        const rec = await safeIdb(idb.get("days", date));
        if (!rec || !Array.isArray(rec.items) || !rec.items.length) continue;
        history.push({ date, items: rec.items.map((n) => normalizeItem(n, ++historyIdSeq)) });
        loadedDates.add(date);
        touchDay(date); // 本会话访问过 → 刷新 lastAccess,LRU 不会把刚看的天当冷数据淘汰
        added = true;
      }
      // 不加 gen 护栏:renderFeed 把 window∪history 按 itemKey 去重再渲,无论 refresh 是否抢先都一致;
      // 反而加护栏会在"缓存天数≤预载上限且 refresh 已落地"时让预载历史这一会话不显示
      if (added) { rebuildThreads(); renderFeedKeepAnchor(); }
    }

    // 3) 离线也能枚举有哪些归档天
    if (archiveDates === null) {
      const idx = await safeIdb(idb.get("meta", "archiveIndex"));
      if (Array.isArray(idx)) archiveDates = idx;
    }
  }

  /* ---------- 启动 ---------- */

  streakDays = updateVisits();
  snapshotSeenBoundary(); // 冷启动先按上次会话划定「上次看到这里」锚点(须在首个 renderAll 前)

  // 本地缓存秒开(消除演示数据闪屏)。迁移后 CACHE_KEY 是瘦身镜像(无正文),正文由 IDB 注水补全
  const cached = store.get(CACHE_KEY, null);
  if (cached && cached.news && cached.news.length) {
    try {
      D = normalizeRemote(cached);
    } catch {}
  }

  rebuildThreads();
  renderAll();
  // 记下当前屏上数据签名:后续 hydrate/refresh 若拿到 generatedAt+条数相同的数据,只更新 D(补正文)不再重渲
  shownSig = D && D.news ? (D.generatedAt || "") + "#" + D.news.length : null;
  bindEvents();
  bindSwipeBack();
  bindPullRefresh();
  bindCategorySwipe();

  hydrateFromIdb(); // 异步、fire-and-forget:只会补充不会清空,首屏秒开不受影响
  requestPersistence();
  refresh(true);

  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreHistory();
    },
    { rootMargin: "500px" }
  ).observe($("#feedMore"));

  // iOS 从主屏幕唤醒 PWA 时常常不重新加载页面:
  // 回到前台主动检查新版本 + 静默刷新新闻,不依赖"重新打开"
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") { lastActiveTs = Date.now(); return; }
    // 回到前台:补记打卡(iOS 保活不重载页面,跨天唤醒否则会漏签导致「连续追新」断签)
    const away = Date.now() - lastActiveTs;
    const s = updateVisits();
    if (s !== streakDays) { streakDays = s; renderHero(); if (activeTab === "me") renderMe(); }
    // 离开超过一个会话间隔再回来,重划「上次看到这里」锚点
    if (away > NEW_SESSION_GAP) snapshotSeenBoundary();
    lastActiveTs = Date.now();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
    }
    checkForUpdate();
    refresh(true);
  });
  checkForUpdate();
})();
