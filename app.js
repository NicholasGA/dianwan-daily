/* ============================================================
   电玩日报 — 交互逻辑
   启动用本地缓存秒开 → 静默拉取 news.json(流水线数据,带全文)
   → 即时增量直连源站。收藏/已读/打卡天数本地持久化。
   ============================================================ */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const CATEGORIES = ["全部", "业界", "主机", "PC", "手游"];
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

  const SEEN_KEY = "dianwanSeen";   // 手动刷新时已见过的新闻(算"新增"用)
  const CACHE_KEY = "dianwanCache"; // 上次成功拉取的数据(秒开用)
  const READ_KEY = "dianwanRead";   // 已读
  const FAV_KEY = "dianwanFavs";    // 收藏
  const VISIT_KEY = "dianwanVisits";// 打卡日期

  const readSet = new Set(store.get(READ_KEY, []));
  const itemKey = (n) => n.url || (n.title || "").slice(0, 24);

  /* ---------- 状态 ---------- */

  let D = window.GameNewsData; // 当前数据(缓存/演示兜底,刷新后替换)
  let activeCategory = "全部";
  let searchQuery = "";
  let streakDays = 1;
  let currentDetailId = null;
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

  function coverMedia(n) {
    if (n.image) {
      return `<img class="cover-img" src="${esc(n.image)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
    }
    return `<span class="cover-deco">${esc(n.cover.glyph)}</span>`;
  }

  /* ---------- 数据归一化 ---------- */

  const httpsImage = (u) => (u && u.startsWith("http://") ? `https://wsrv.nl/?url=${encodeURIComponent(u.slice(7))}` : u);

  function sanitizeBlocks(content) {
    if (!Array.isArray(content)) return null;
    const blocks = content
      .filter(
        (b) =>
          b &&
          typeof b.v === "string" &&
          (b.t === "p" || b.t === "h" || (b.t === "img" && /^https?:\/\//.test(b.v)))
      )
      .map((b) => (b.t === "img" ? { t: "img", v: httpsImage(b.v) } : b));
    return blocks.length ? blocks : null;
  }

  function normalizeItem(n, id) {
    const cleanUrl = /^https?:\/\//.test(n.url || "") ? n.url.replace(/["'\\]/g, "") : null;
    const cleanImg = /^https?:\/\//.test(n.image || "") ? httpsImage(n.image.replace(/["'\\]/g, "")) : null;
    return {
      id,
      category: CATEGORIES.includes(n.category) ? n.category : "业界",
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
      cover: { ...PALETTES[id % PALETTES.length], glyph: (n.source || "News").slice(0, 2) },
      blocks: sanitizeBlocks(n.content),
      content: n.summary ? [n.summary] : [],
    };
  }

  function normalizeRemote(remote) {
    const news = (remote.news || []).map((n, i) => normalizeItem(n, n.id || i + 1));
    const byImageFirst = (arr) => [...arr].sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
    const featuredIds = byImageFirst(news).slice(0, 5).map((n) => n.id);
    const topicIds = byImageFirst(news.filter((n) => !featuredIds.includes(n.id)))
      .slice(0, 4)
      .map((n) => n.id);
    const flash = (remote.flash || []).slice(0, 16).map((f) => ({
      time: new Date(f.ts || Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      text: esc(f.text),
      id: f.id || null,
    }));
    return {
      date: (remote.generatedAt || "").slice(0, 10),
      generatedAt: remote.generatedAt,
      featuredIds,
      topicIds,
      news,
      flash,
    };
  }

  /* ---------- 即时增量抓取(刷新时直连源站) ---------- */

  function categorizeClient(text) {
    if (/(手游|移动端|iOS|安卓|Android|原神|崩坏|鸣潮|明日方舟|王者荣耀|和平精英|二游|抽卡|mobile game|TapTap|App Store|开启预约|公测)/i.test(text)) return "手游";
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

  async function proxyFetch(url) {
    const proxies = [
      (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];
    let lastErr;
    for (const p of proxies) {
      try {
        const res = await fetch(p(url), { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.text();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
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
  async function refresh(silent) {
    if (refreshing) return;
    refreshing = true;
    $$(".refresh-btn svg").forEach((s) => s.classList.add("spin"));
    try {
      const [res, instantResult] = await Promise.all([
        fetch("news.json", { cache: "no-store" }),
        fetchInstant().catch(() => []),
      ]);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const remote = await res.json();
      if (!remote.news || !remote.news.length) throw new Error("empty");

      // 即时增量:全量合并(按 URL/标题去重),整体按时间重排
      const baseTitles = new Set(remote.news.map((n) => (n.title || "").slice(0, 18)));
      const baseUrls = new Set(remote.news.map((n) => n.url));
      const fresh = instantResult
        .filter((n) => !baseUrls.has(n.url) && !baseTitles.has(n.title.slice(0, 18)))
        .filter((n, i, arr) => arr.findIndex((x) => x.title.slice(0, 18) === n.title.slice(0, 18)) === i)
        .slice(0, 40)
        .map((n) => ({ ...n, category: categorizeClient(n.title + " " + n.summary), content: null }));

      const combinedNews = [...fresh, ...remote.news]
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .map((n, i) => ({ ...n, id: i + 1 }));
      const combined = {
        generatedAt: remote.generatedAt,
        news: combinedNews,
        flash: combinedNews.slice(0, 16).map((n) => ({ ts: n.ts, text: n.title, id: n.id })),
      };
      D = normalizeRemote(combined);
      renderAll();
      store.set(CACHE_KEY, combined); // 下次启动秒开

      // 新增统计:只在手动刷新时记账(启动静默刷新不算"看过")
      if (!silent) {
        const keys = combinedNews.map(itemKey);
        const prev = store.get(SEEN_KEY, []);
        const prevSet = new Set(prev);
        const freshCount = keys.filter((k) => !prevSet.has(k)).length;
        store.set(SEEN_KEY, [...new Set([...keys, ...prev])].slice(0, 600));
        toast(
          prev.length === 0
            ? `已更新 · ${combinedNews.length} 条新闻`
            : freshCount > 0
              ? `比上次刷新新增 ${freshCount} 条`
              : "已是最新,没有新内容"
        );
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
    const note = D.generatedAt
      ? `来源:游民星空 / 3DM / 机核 / 游研社 / 触乐 / indienova / IGN / GameSpot · 更新于 ${new Date(D.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "演示数据 · 下拉刷新获取真实新闻";
    $$(".demo-note").forEach((el) => (el.textContent = note));
  }

  function renderFeatured() {
    const items = D.featuredIds.map(findNews).filter(Boolean);
    $("#featuredCount").textContent = items.length;
    $("#featuredRow").innerHTML = items
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
  }

  function renderChips() {
    $("#chipsRow").innerHTML = CATEGORIES.map((cat) => {
      const count = cat === "全部" ? D.news.length : D.news.filter((n) => n.category === cat).length;
      return `<button class="chip${cat === activeCategory ? " chip-on" : ""}" data-cat="${cat}">${cat}<span class="chip-count">${count}</span></button>`;
    }).join("");
  }

  function renderTopics() {
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

  function newsItemHtml(n) {
    const read = readSet.has(itemKey(n)) ? " is-read" : "";
    return `
      <article class="news-item${read}" data-id="${n.id}">
        <div class="news-main">
          <span class="news-cat">${esc(n.category)}</span>
          <h4 class="news-title">${esc(n.title)}</h4>
          <div class="news-meta">
            <span>${esc(n.source)}</span><span>${esc(n.time)}</span>
          </div>
        </div>
        <div class="news-thumb" style="${coverStyle(n.cover)}">
          ${n.image ? `<img class="thumb-img" src="${esc(n.image)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="thumb-glyph">${esc(n.cover.glyph)}</span>`}
          ${videoBadge(n)}
        </div>
      </article>`;
  }

  function formatDay(d) {
    const [y, m, dd] = d.split("-").map(Number);
    const wd = "日一二三四五六"[new Date(y, m - 1, dd).getDay()];
    return `${m} 月 ${dd} 日 · 周${wd}`;
  }

  function renderFeed() {
    const q = searchQuery.toLowerCase();
    const match = (n) =>
      (activeCategory === "全部" || n.category === activeCategory) &&
      (!q || (n.title + " " + n.summary + " " + n.source).toLowerCase().includes(q));
    let html = D.news.filter(match).map(newsItemHtml).join("");
    const windowKeys = new Set(D.news.map(itemKey));
    for (const g of history) {
      const items = g.items.filter((n) => match(n) && !windowKeys.has(itemKey(n)));
      if (!items.length) continue;
      html += `<div class="feed-day">${formatDay(g.date)}</div>` + items.map(newsItemHtml).join("");
    }
    if (!html && q) html = `<p class="feed-empty">没有找到包含「${esc(searchQuery)}」的新闻<br><span>搜索范围是已加载的新闻,下滑加载更多历史后可再搜</span></p>`;
    $("#feedList").innerHTML = html;
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
  }

  function renderFavs() {
    const favs = getFavs();
    favViewItems = [...favs].reverse().map((f, i) => normalizeItem(f, 200000 + i));
    $("#favsList").innerHTML = favViewItems.map(newsItemHtml).join("");
    $("#favsEmpty").classList.toggle("hidden", favViewItems.length > 0);
    $("#favsCount").textContent = favViewItems.length ? `${favViewItems.length} 条收藏` : "长按保存喜欢的新闻";
  }

  function renderMe() {
    $("#meStreak").textContent = streakDays;
    $("#meRead").textContent = readSet.size;
    $("#meFavs").textContent = getFavs().length;
    $("#meDate").textContent = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  }

  function renderAll() {
    renderHero();
    renderFeatured();
    renderChips();
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
  const loadedDates = new Set();
  const history = [];
  let historyLoading = false;
  let historyIdSeq = 100000;

  async function loadMoreHistory() {
    if (historyLoading) return;
    historyLoading = true;
    const more = $("#feedMore");
    try {
      if (archiveDates === null) {
        try {
          const r = await fetch("archive/index.json", { cache: "no-store" });
          archiveDates = r.ok ? await r.json() : [];
        } catch {
          archiveDates = [];
        }
      }
      while (true) {
        const next = (archiveDates || []).find((d) => !loadedDates.has(d));
        if (!next) {
          more.textContent = archiveDates && archiveDates.length ? "没有更早的新闻了" : "暂无历史归档";
          return;
        }
        more.textContent = "加载更早的新闻…";
        const r = await fetch(`archive/${next}.json`);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const day = await r.json();
        loadedDates.add(next);
        const windowKeys = new Set(D.news.map(itemKey));
        const items = (day.items || []).map((n) => normalizeItem(n, ++historyIdSeq));
        history.push({ date: next, items });
        if (items.some((n) => !windowKeys.has(itemKey(n)))) {
          renderFeed();
          more.textContent = "继续下滑加载更早";
          break;
        }
      }
    } catch {
      more.textContent = "加载失败,继续下滑重试";
    } finally {
      historyLoading = false;
    }
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

  const CLIENT_BOILER = /(本文由游民星空|更多相关资讯请关注|转载请注明|责任编辑|关注游民星空|点击进入专题|友情提示|点此前往|游民星空APP|随时掌握游戏情报|出版物经营许可证|京ICP备|京公网安备|人喜欢$)/;

  function htmlBlocksClient(html) {
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
    { host: "gamersky.com", rx: /<div class="Mid2L_con">([\s\S]*?)(?:<span id="pe100_page_contentpage|<!--文章内容导航|<a class="diggBtn|$)/ },
    { host: "3dmgame.com", rx: /<div class="news_warp_center">([\s\S]*?)(?:class="bq|$)/ },
    { host: "yystv.cn", rx: /<div class="doc-content[^"]*"[^>]*>([\s\S]*?)(?:class="article-links-container|class="qrcode-block|class="doc-share|$)/ },
    { host: "chuapp.com", rx: /<div class="the-content[^"]*"[^>]*>([\s\S]*?)(?:<!--end-->|<!--评论start|相关文章|$)/ },
  ];

  const canFetchFullText = (n) =>
    !!n.url && (/gcores\.com\/articles\/\d+/.test(n.url) || CLIENT_CONTAINERS.some((c) => n.url.includes(c.host)));

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

  function renderDetailBody(n) {
    if (n.blocks) {
      $("#detailContent").innerHTML = n.blocks
        .map((b) => {
          if (b.t === "img")
            return `<img class="detail-img" src="${esc(b.v)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
          if (b.t === "h") return `<h3 class="detail-h">${esc(b.v)}</h3>`;
          return `<p>${esc(b.v)}</p>`;
        })
        .join("");
      $("#detailLink").innerHTML = n.url
        ? `<a class="origin-link" href="${esc(n.url)}" target="_blank" rel="noopener">内容整理自 ${esc(n.source)} · 查看原文 ↗</a>`
        : "";
    } else {
      $("#detailContent").innerHTML = n.content.map((p) => `<p>${esc(p)}</p>`).join("");
      $("#detailLink").innerHTML = n.url
        ? `<a class="src-link" href="${esc(n.url)}" target="_blank" rel="noopener">${n.isVideo ? "▶ 观看视频" : "↗ 阅读原文"}<span>${esc(n.source)}</span></a>`
        : "";
    }
  }

  function openDetail(id) {
    const n = findNews(id);
    if (!n) return;
    currentDetailId = id;
    const cover = $("#detailCover");
    cover.style.cssText = coverStyle(n.cover);
    if (n.image) {
      cover.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.45)), url("${n.image}")`;
      cover.style.backgroundSize = "cover";
      cover.style.backgroundPosition = "center";
    }
    $("#detailTag").textContent = n.category;
    $("#detailTitle").textContent = n.title;
    $("#detailTitleEn").textContent = n.titleEn || "";
    $("#detailTitleEn").classList.toggle("hidden", !n.titleEn);
    $("#detailMeta").innerHTML = `<span>${esc(n.source)}</span><span>${esc(n.time)}</span>`;
    renderDetailBody(n);
    // 无全文且来源可解析:现场抓原文(代理/机核 API),抓到后就地渲染
    if (!n.blocks && canFetchFullText(n)) {
      $("#detailContent").insertAdjacentHTML("beforeend", '<p class="detail-loading" id="detailLoading">正在加载全文…</p>');
      const wantId = id;
      fetchFullText(n)
        .then((blocks) => {
          const sb = sanitizeBlocks(blocks);
          if (sb) n.blocks = sb;
          if (currentDetailId === wantId) renderDetailBody(n);
        })
        .catch(() => {
          if (currentDetailId === wantId) $("#detailLoading")?.remove();
        });
    }
    $("#actLike").classList.remove("acted");
    $("#actFav").classList.toggle("acted", isFaved(n));
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

  function toggleFav(id) {
    const n = findNews(id);
    if (!n) return;
    let favs = getFavs();
    const key = itemKey(n);
    if (favs.some((f) => itemKey(f) === key)) {
      favs = favs.filter((f) => itemKey(f) !== key);
      toast("已取消收藏");
    } else {
      favs.push({
        title: n.title,
        titleEn: n.titleEn,
        summary: n.summary,
        source: n.source,
        url: n.url,
        image: n.image,
        isVideo: n.isVideo,
        ts: n.ts,
        category: n.category,
        content: n.blocks,
      });
      favs = favs.slice(-100);
      toast("已收藏,可在「收藏」页查看");
    }
    store.set(FAV_KEY, favs);
    $("#actFav").classList.toggle("acted", favs.some((f) => itemKey(f) === key));
    renderHero();
    if (!$("#view-favs").classList.contains("hidden")) renderFavs();
  }

  async function shareNews(id) {
    const n = findNews(id);
    if (!n) return;
    const url = n.url || location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: n.title, url });
      } catch {}
    } else if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(`${n.title} ${url}`);
        toast("链接已复制");
      } catch {}
    }
  }

  /* ---------- 标签栏 ---------- */

  let activeTab = "home";
  function switchTab(tab) {
    if (tab === activeTab) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    activeTab = tab;
    $$(".tab").forEach((b) => b.classList.toggle("tab-active", b.dataset.tab === tab));
    $("#view-home").classList.toggle("hidden", tab !== "home");
    $("#view-flash").classList.toggle("hidden", tab !== "flash");
    $("#view-favs").classList.toggle("hidden", tab !== "favs");
    $("#view-me").classList.toggle("hidden", tab !== "me");
    if (tab === "favs") renderFavs();
    if (tab === "me") renderMe();
    window.scrollTo(0, 0);
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    $("#chipsRow").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      activeCategory = chip.dataset.cat;
      renderChips();
      renderFeed();
    });

    document.body.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const card = e.target.closest("[data-id]");
      if (card && !e.target.closest(".chip")) openDetail(Number(card.dataset.id));
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
    $("#actShare").addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentDetailId != null) shareNews(currentDetailId);
    });

    // 搜索
    $("#searchBtn").addEventListener("click", () => {
      const row = $("#searchRow");
      row.classList.toggle("hidden");
      if (!row.classList.contains("hidden")) $("#searchInput").focus();
      else {
        searchQuery = "";
        $("#searchInput").value = "";
        renderFeed();
      }
    });
    let searchTimer = null;
    $("#searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = e.target.value.trim();
        renderFeed();
      }, 150);
    });
    $("#searchClear").addEventListener("click", () => {
      searchQuery = "";
      $("#searchInput").value = "";
      $("#searchRow").classList.add("hidden");
      renderFeed();
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
        mode = null;
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

  /* ---------- PWA:离线缓存 ---------- */

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  /* ---------- 启动 ---------- */

  streakDays = updateVisits();

  // 本地缓存秒开(消除演示数据闪屏)
  const cached = store.get(CACHE_KEY, null);
  if (cached && cached.news && cached.news.length) {
    try {
      D = normalizeRemote(cached);
    } catch {}
  }

  renderAll();
  bindEvents();
  bindSwipeBack();
  bindPullRefresh();
  refresh(true);

  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreHistory();
    },
    { rootMargin: "500px" }
  ).observe($("#feedMore"));
})();
