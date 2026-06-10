/* ============================================================
   电玩日报 — 交互逻辑
   启动时使用 data.js 演示数据,随后自动拉取 news.json(由
   GitHub Actions 每小时抓取真实新闻生成),刷新按钮手动更新。
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

  let D = window.GameNewsData; // 当前数据(演示数据兜底,刷新后被真实新闻替换)
  let activeCategory = "全部";

  /* ---------- 工具 ---------- */

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const coverStyle = (cover) => `--c1:${cover.c1};--c2:${cover.c2};--fg:${cover.fg}`;

  const findNews = (id) => D.news.find((n) => n.id === id);

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

  /* ---------- 远程数据(news.json) ---------- */

  function normalizeRemote(remote) {
    const news = (remote.news || []).map((n, i) => {
      const cleanUrl = /^https?:\/\//.test(n.url || "") ? n.url.replace(/["'\\]/g, "") : null;
      const cleanImg = /^https?:\/\//.test(n.image || "") ? n.image.replace(/["'\\]/g, "") : null;
      return {
        id: i + 1,
        category: CATEGORIES.includes(n.category) ? n.category : "业界",
        title: n.title || "",
        short: n.title || "",
        summary: n.summary || "",
        source: n.source || "",
        time: relTime(n.ts || Date.now()),
        comments: null,
        url: cleanUrl,
        image: cleanImg,
        isVideo: !!n.isVideo,
        cover: { ...PALETTES[i % PALETTES.length], glyph: (n.source || "News").slice(0, 2) },
        content: n.summary ? [n.summary] : [],
      };
    });

    const byImageFirst = (arr) => [...arr].sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
    const featuredIds = byImageFirst(news).slice(0, 5).map((n) => n.id);
    const topicIds = byImageFirst(news.filter((n) => !featuredIds.includes(n.id)))
      .slice(0, 4)
      .map((n) => n.id);

    const flash = (remote.flash || []).slice(0, 10).map((f) => ({
      time: new Date(f.ts || Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      text: esc(f.text), // 远程文本统一转义(flash 渲染时按 HTML 插入)
      url: /^https?:\/\//.test(f.url || "") ? f.url.replace(/["'\\]/g, "") : null,
    }));

    return {
      date: (remote.generatedAt || "").slice(0, 10),
      generatedAt: remote.generatedAt,
      streak: D.streak,
      featuredIds,
      topicIds,
      news,
      flash,
    };
  }

  let refreshing = false;
  async function refresh(silent) {
    if (refreshing) return;
    refreshing = true;
    $$(".refresh-btn svg").forEach((s) => s.classList.add("spin"));
    try {
      const res = await fetch("news.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const remote = await res.json();
      if (!remote.news || !remote.news.length) throw new Error("empty");
      D = normalizeRemote(remote);
      renderAll();
      if (!silent) toast(`已更新 · ${D.news.length} 条新闻`);
    } catch (err) {
      if (!silent) toast("刷新失败,显示已缓存内容");
    } finally {
      refreshing = false;
      $$(".refresh-btn svg").forEach((s) => s.classList.remove("spin"));
    }
  }

  /* ---------- 渲染 ---------- */

  function renderHero() {
    $("#headline").innerHTML = `今日 ${D.news.length} 条<br>游戏新闻`;
    $("#streakTitle").textContent = `哇!连续追新 ${D.streak.days} 天`;
    $("#streakSub").textContent = `你比 ${D.streak.percent}% 的玩家更早知道业界动态`;
    $("#flashDate").textContent = `${D.date} · 实时业界动态速递`;
    const note = D.generatedAt
      ? `新闻来源:机核 / 游研社 / 触乐 / IGN / GameSpot · 更新于 ${new Date(D.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "演示数据 · 点击刷新获取真实新闻";
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
        <div class="cover-sub">${esc(n.source)} · ${n.comments != null ? n.comments + " 评论" : n.time}</div>
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

  function renderFeed() {
    const list = activeCategory === "全部" ? D.news : D.news.filter((n) => n.category === activeCategory);
    $("#feedList").innerHTML = list
      .map(
        (n) => `
      <article class="news-item" data-id="${n.id}">
        <div class="news-main">
          <span class="news-cat">${esc(n.category)}</span>
          <h4 class="news-title">${esc(n.title)}</h4>
          <div class="news-meta">
            <span>${esc(n.source)}</span><span>${esc(n.time)}</span>${n.comments != null ? `<span>💬 ${n.comments}</span>` : ""}
          </div>
        </div>
        <div class="news-thumb" style="${coverStyle(n.cover)}">
          ${n.image ? `<img class="thumb-img" src="${esc(n.image)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="thumb-glyph">${esc(n.cover.glyph)}</span>`}
          ${videoBadge(n)}
        </div>
      </article>`
      )
      .join("");
  }

  function renderFlash() {
    $("#flashList").innerHTML = D.flash
      .map((f, i) => {
        // 演示数据的 text 含可信的 <b> 标签;远程数据在 normalizeRemote 已转义
        const body = f.url
          ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${f.text} <span class="flash-link">↗</span></a>`
          : f.text;
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

  function renderAll() {
    renderHero();
    renderFeatured();
    renderChips();
    renderTopics();
    renderFeed();
    renderFlash();
  }

  /* ---------- 文章详情 ---------- */

  function openDetail(id) {
    const n = findNews(id);
    if (!n) return;
    const cover = $("#detailCover");
    cover.style.cssText = coverStyle(n.cover);
    if (n.image) {
      cover.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.45)), url("${n.image}")`;
      cover.style.backgroundSize = "cover";
      cover.style.backgroundPosition = "center";
    }
    $("#detailTag").textContent = n.category;
    $("#detailTitle").textContent = n.title;
    $("#detailMeta").innerHTML = `<span>${esc(n.source)}</span><span>${esc(n.time)}</span>${n.comments != null ? `<span>💬 ${n.comments} 评论</span>` : ""}`;
    $("#detailContent").innerHTML = n.content.map((p) => `<p>${esc(p)}</p>`).join("");
    $("#detailLink").innerHTML = n.url
      ? `<a class="src-link" href="${esc(n.url)}" target="_blank" rel="noopener">${n.isVideo ? "▶ 观看视频" : "↗ 阅读原文"}<span>${esc(n.source)}</span></a>`
      : "";
    $$(".act").forEach((b) => b.classList.remove("acted"));
    const detail = $("#detail");
    detail.classList.remove("hidden");
    detail.scrollTop = 0;
  }

  function closeDetail() {
    $("#detail").classList.add("hidden");
  }

  /* ---------- 标签栏 ---------- */

  function switchTab(tab) {
    if (tab === "video" || tab === "community" || tab === "me") {
      toast("演示版:该板块尚未开放");
      return;
    }
    $$(".tab").forEach((b) => b.classList.toggle("tab-active", b.dataset.tab === tab));
    $("#view-home").classList.toggle("hidden", tab !== "home");
    $("#view-flash").classList.toggle("hidden", tab !== "flash");
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
      if (e.target.closest("a")) return; // 链接(快讯跳转/阅读原文)走默认行为
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

    $$(".act").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        btn.classList.toggle("acted");
        toast(btn.classList.contains("acted") ? "已收到你的反馈" : "已取消");
      });
    });
  }

  /* ---------- PWA:离线缓存 ---------- */

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* HTTP(非 localhost)环境下不可用,忽略 */
    });
  }

  /* ---------- 启动 ---------- */

  renderAll();
  bindEvents();
  refresh(true); // 启动时静默拉取真实新闻
})();
