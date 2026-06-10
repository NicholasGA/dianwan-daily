/* ============================================================
   电玩日报 — 交互逻辑
   ============================================================ */

(function () {
  const D = window.GameNewsData;
  const $ = (sel) => document.querySelector(sel);

  const CATEGORIES = ["全部", "业界", "主机", "PC", "手游"];
  let activeCategory = "全部";

  /* ---------- 工具 ---------- */

  function coverStyle(cover) {
    return `--c1:${cover.c1};--c2:${cover.c2};--fg:${cover.fg}`;
  }

  function findNews(id) {
    return D.news.find((n) => n.id === id);
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 1600);
  }

  /* ---------- Hero 文案 ---------- */

  function renderHero() {
    $("#headline").innerHTML = `今日 ${D.news.length} 条<br>游戏新闻`;
    $("#streakTitle").textContent = `哇!连续追新 ${D.streak.days} 天`;
    $("#streakSub").textContent = `你比 ${D.streak.percent}% 的玩家更早知道业界动态`;
    $("#flashDate").textContent = `${D.date} · 实时业界动态速递`;
  }

  /* ---------- 头条书架轮播 ---------- */

  function renderFeatured() {
    const row = $("#featuredRow");
    const items = D.featuredIds.map(findNews).filter(Boolean);
    $("#featuredCount").textContent = items.length;
    row.innerHTML = items
      .map(
        (n) => `
      <div class="cover" style="${coverStyle(n.cover)}" data-id="${n.id}">
        <span class="cover-deco">${n.cover.glyph}</span>
        <span class="cover-tag">${n.category}</span>
        <div class="cover-title">${n.short || n.title}</div>
        <div class="cover-sub">${n.source} · ${n.comments} 评论</div>
      </div>`
      )
      .join("");
  }

  /* ---------- 分类胶囊 ---------- */

  function renderChips() {
    const row = $("#chipsRow");
    row.innerHTML = CATEGORIES.map((cat) => {
      const count =
        cat === "全部"
          ? D.news.length
          : D.news.filter((n) => n.category === cat).length;
      const on = cat === activeCategory ? " chip-on" : "";
      return `<button class="chip${on}" data-cat="${cat}">${cat}<span class="chip-count">${count}</span></button>`;
    }).join("");
  }

  /* ---------- 专题 2x2 封面 ---------- */

  function renderTopics() {
    $("#topicGrid").innerHTML = D.topicIds
      .map(findNews)
      .filter(Boolean)
      .map(
        (n) => `
      <div class="topic-cover" style="${coverStyle(n.cover)}" data-id="${n.id}">
        <span class="cover-deco">${n.cover.glyph}</span>
        <div class="topic-cover-title">${n.short || n.title}</div>
      </div>`
      )
      .join("");
  }

  /* ---------- 资讯流 ---------- */

  function renderFeed() {
    const list =
      activeCategory === "全部"
        ? D.news
        : D.news.filter((n) => n.category === activeCategory);
    $("#feedList").innerHTML = list
      .map(
        (n) => `
      <article class="news-item" data-id="${n.id}">
        <div class="news-main">
          <span class="news-cat">${n.category}</span>
          <h4 class="news-title">${n.title}</h4>
          <div class="news-meta">
            <span>${n.source}</span><span>${n.time}</span><span>💬 ${n.comments}</span>
          </div>
        </div>
        <div class="news-thumb" style="${coverStyle(n.cover)}">
          <span class="thumb-glyph">${n.cover.glyph}</span>
        </div>
      </article>`
      )
      .join("");
  }

  /* ---------- 快讯 ---------- */

  function renderFlash() {
    $("#flashList").innerHTML = D.flash
      .map(
        (f, i) => `
      <div class="flash-item">
        <span class="flash-time">${f.time}</span>
        ${i < D.flash.length - 1 ? '<span class="flash-line"></span>' : ""}
        <span class="flash-dot"></span>
        <p class="flash-text">${f.text}</p>
      </div>`
      )
      .join("");
  }

  /* ---------- 文章详情 ---------- */

  function openDetail(id) {
    const n = findNews(id);
    if (!n) return;
    $("#detailCover").style.cssText = coverStyle(n.cover);
    $("#detailTag").textContent = n.category;
    $("#detailTitle").textContent = n.title;
    $("#detailMeta").innerHTML = `<span>${n.source}</span><span>${n.time}</span><span>💬 ${n.comments} 评论</span>`;
    $("#detailContent").innerHTML = n.content.map((p) => `<p>${p}</p>`).join("");
    document.querySelectorAll(".act").forEach((b) => b.classList.remove("acted"));
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
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("tab-active", b.dataset.tab === tab);
    });
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

    // 点击封面 / 列表项打开详情
    document.body.addEventListener("click", (e) => {
      const card = e.target.closest("[data-id]");
      if (card && !e.target.closest(".chip")) {
        openDetail(Number(card.dataset.id));
      }
    });

    $("#detailBack").addEventListener("click", (e) => {
      e.stopPropagation();
      closeDetail();
    });

    $("#tabbar").addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      if (tab) switchTab(tab.dataset.tab);
    });

    document.querySelectorAll(".act").forEach((btn) => {
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

  renderHero();
  renderFeatured();
  renderChips();
  renderTopics();
  renderFeed();
  renderFlash();
  bindEvents();
})();
