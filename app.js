/* ============================================================
   电玩日报 — 交互逻辑
   启动用本地缓存秒开 → 静默拉取 news.json(流水线数据,带全文)
   → 即时增量直连源站。收藏/已读/打卡天数本地持久化。
   ============================================================ */

(function () {
  const APP_BUILD = "v29 · 2026-06-13"; // 与 sw.js 缓存版本同步更新
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
  const WORKER_KEY = "dwWorker";    // 用户自建图片代理(Cloudflare Worker)网址

  let WORKER_PROXY = store.get(WORKER_KEY, "");

  const readSet = new Set(store.get(READ_KEY, []));
  const itemKey = (n) => n.url || (n.title || "").slice(0, 24);

  /* ---------- 状态 ---------- */

  let D = window.GameNewsData; // 当前数据(缓存/演示兜底,刷新后替换)
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

  const FOREIGN_RE = /ignimgs\.com|gamespot|cbsistatic\.com|chuapp\.com/i;
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
      (glyph ? ` data-glyph="${esc(glyph)}"` : "") + ` onerror="dwImgError(this)">`;
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
        sources: remote.sources || null,
        news: combinedNews,
        flash: combinedNews.slice(0, 24).map((n) => ({ ts: n.ts, text: n.title, id: n.id })),
      };
      D = normalizeRemote(combined);
      renderAll();
      store.set(CACHE_KEY, combined); // 下次启动秒开

      // 正在阅读的文章若在新数据里有了全文,就地补全
      if (currentDetailKey && !$("#detail").classList.contains("hidden")) {
        const freshItem = D.news.find((x) => itemKey(x) === currentDetailKey);
        if (freshItem && freshItem.blocks) {
          currentDetailId = freshItem.id;
          renderDetailBody(freshItem);
        }
      }

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
        // 抓到新内容时回到顶部、切回全部,确保新条目可见
        if (freshCount > 0 && activeTab === "home") {
          activeCategory = "全部";
          searchQuery = "";
          renderChips();
          renderFeed();
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

  function newsItemHtml(n) {
    const read = readSet.has(itemKey(n)) ? " is-read" : "";
    return `
      <article class="news-item${read}" data-id="${n.id}">
        <div class="news-main">
          <span class="news-cat">${esc(n.category)}</span>${n.hot > 1 ? `<span class="hot-badge">🔥 ${n.hot} 源同报</span>` : ""}
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

  // 窗口 + 已加载归档合并成一条连续时间长河(去重,按时间倒序,按天分隔)
  function renderFeed() {
    const q = searchQuery.toLowerCase();
    const match = (n) =>
      (activeCategory === "全部" || n.category === activeCategory) &&
      (!q || (n.title + " " + n.summary + " " + n.source).toLowerCase().includes(q));
    const seenK = new Set();
    const river = [];
    for (const n of [...D.news, ...history.flatMap((g) => g.items)]) {
      const k = itemKey(n);
      if (seenK.has(k)) continue;
      seenK.add(k);
      if (match(n)) river.push(n);
    }
    river.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // 跨轮次同题合并:72 小时内的同一事件只显示一条,被并入的来源计入🔥
    const deduped = [];
    for (const n of river) {
      let dup = null;
      for (let i = deduped.length - 1; i >= 0; i--) {
        const k = deduped[i];
        if ((k.ts || 0) - (n.ts || 0) > 72 * 3600 * 1000) break;
        if (sameStoryClient(k, n)) {
          dup = k;
          break;
        }
      }
      if (dup) {
        dup.hotSources = dup.hotSources || [dup.source];
        if (!dup.hotSources.includes(n.source)) {
          dup.hotSources.push(n.source);
          dup.hot = dup.hotSources.length;
        }
        continue;
      }
      deduped.push(n);
    }
    river.length = 0;
    river.push(...deduped);
    riverOrder = river; // 详情页「下一篇」按当前信息流顺序

    const todayKey = dayKeyOf(Date.now());
    const yesterdayKey = dayKeyOf(Date.now() - 86400000);
    let lastDay = null;
    let html = "";
    for (const n of river) {
      const d = n.ts ? dayKeyOf(n.ts) : todayKey;
      if (d !== lastDay) {
        lastDay = d;
        if (d !== todayKey) {
          html += `<div class="feed-day">${d === yesterdayKey ? "昨天" : formatDay(d)}</div>`;
        }
      }
      html += newsItemHtml(n);
    }
    if (!html && q) html = `<p class="feed-empty">没有找到包含「${esc(searchQuery)}」的新闻<br><span>搜索范围是已加载的新闻,下滑加载更多历史后可再搜</span></p>`;
    $("#feedList").innerHTML = html;
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
      : "游民星空 · 3DM · 机核 · 游研社 · 触乐 · indienova · IGN · GameSpot";
    const wi = $("#meWorker");
    if (wi) wi.value = WORKER_PROXY;
    const ws = $("#meWorkerState");
    if (ws) ws.textContent = WORKER_PROXY ? "已启用自建图片代理" : "未配置(默认用公共代理)";
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
  let riverOrder = [];
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
          renderFeedKeepAnchor();
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
        fetch(`archive/${day}.json`, { signal: AbortSignal.timeout(15000) })
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((j) => j.items || [])
          .catch(() => {
            dayFileCache.delete(day); // 失败不缓存,允许重试
            return [];
          })
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

  function renderDetailBody(n) {
    if (n.blocks) {
      $("#detailContent").innerHTML = n.blocks
        .map((b) => {
          if (b.t === "img") return imgTag("detail-img", b.v, "detail", "");
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
  }

  function openDetail(id) {
    const n = findNews(id);
    if (!n) return;
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
    $("#detailMeta").innerHTML =
      `<span>${esc(n.source)}</span><span>${esc(n.time)}</span>` +
      (n.hot > 1 ? `<span class="hot-meta">🔥 ${n.hotSources ? esc(n.hotSources.join("、")) : n.hot + " 家媒体"}同报</span>` : "");
    renderDetailBody(n);
    // 无全文时的三级管道:当日归档 → 现场抓原文(代理/机核 API) → 摘要兜底
    if (!n.blocks && (n.fullArchived || canFetchFullText(n))) {
      $("#detailContent").insertAdjacentHTML("beforeend", '<p class="detail-loading" id="detailLoading">正在加载全文…</p>');
      const wantId = id;
      (async () => {
        let blocks = null;
        if (n.fullArchived) {
          try {
            blocks = await contentFromArchive(n);
          } catch {}
        }
        if (!blocks && canFetchFullText(n)) {
          try {
            blocks = await fetchFullText(n);
          } catch {}
        }
        const sb = sanitizeBlocks(blocks);
        if (sb) {
          n.blocks = sb;
          if (currentDetailId === wantId) renderDetailBody(n);
        } else if (currentDetailId === wantId) {
          const el = $("#detailLoading");
          if (el) el.textContent = "原文暂时取不到 · 全文将在 15 分钟内随自动更新补全,可先看摘要或跳转原文";
        }
      })();
    }
    // 下一篇(按当前信息流顺序)
    const idx = riverOrder.findIndex((r) => r.id === id);
    const next = idx >= 0 ? riverOrder[idx + 1] : null;
    $("#detailNext").innerHTML = next
      ? `<button class="next-card" data-id="${next.id}"><span>下一篇</span><b>${esc(next.title)}</b></button>`
      : "";
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
        fullArchived: n.fullArchived || undefined,
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
      // 正文图片 → 灯箱大图
      if (e.target.classList.contains("detail-img")) {
        const orig = e.target.dataset.orig;
        $("#lightboxImg").src = orig ? imgSrc(orig, "full") : e.target.src;
        $("#lightbox").classList.remove("hidden");
        return;
      }
      const card = e.target.closest("[data-id]");
      if (card && !e.target.closest(".chip")) openDetail(Number(card.dataset.id));
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

    $("#meWorkerSave").addEventListener("click", saveWorker);
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

  /* ---------- 手势:主界面左右滑切换分区 ---------- */

  function switchCategory(cat, dir) {
    if (cat === activeCategory) return;
    activeCategory = cat;
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
  bindCategorySwipe();
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
    if (document.visibilityState !== "visible") return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
    }
    checkForUpdate();
    refresh(true);
  });
  checkForUpdate();
})();
