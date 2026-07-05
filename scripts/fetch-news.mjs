/* ============================================================
   电玩日报 — 新闻抓取脚本(GitHub Actions 定时运行)
   1) 从各游戏媒体收集新闻(RSS / 列表页解析)
   2) 进入每篇文章页提取全文(文字+配图的结构化块),App 内直接阅读
   生成 news.json。无第三方依赖,Node 18+ 自带 fetch。
   ============================================================ */

import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";

const CONCURRENCY = 6;
const MAX_BLOCKS = 60;
const MAX_TEXT = 7000;
const MAX_IMGS = 12;

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) dianwan-daily" };

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", hellip: "…", mdash: "—" };
const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

function field(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  const cd = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cd) v = cd[1].trim();
  return v;
}

const stripTags = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// http 图床(如触乐)在 HTTPS 站点会被混合内容策略拦截,经 wsrv.nl 图片代理转 https
// 不在抓取端预代理:存原始 URL,代理/兜底决策全部交给客户端的四级级联
const httpsImage = (u) => u || null;

async function get(url) {
  // 触乐等 http 源从 Actions 运行器抓取偶发超时,失败重试一次
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (err) {
      if (attempt >= 1) throw err;
    }
  }
}

/* ---------- 元数据收集:RSS 源 ---------- */

function pickImage(item, desc) {
  const thumb = field(item, "thumb");
  if (thumb) return decode(thumb);
  const enc = item.match(/<enclosure[^>]+url="([^"]+)"[^>]*>/i);
  if (enc && /image|jpe?g|png|webp/i.test(enc[0])) return decode(enc[1]);
  const media = item.match(/<media:(?:content|thumbnail)[^>]+url="([^"]+)"/i);
  if (media) return decode(media[1]);
  const img = desc.match(/<img[^>]+src="([^"]+)"/i);
  if (img) return decode(img[1]);
  return null;
}

async function fetchRss(feed) {
  const xml = await get(feed.url);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const out = [];
  for (const item of items) {
    const link = decode(field(item, "link"));
    if (!link || (feed.skip && feed.skip.test(link))) continue;
    const title = stripTags(field(item, "title"));
    if (!title) continue;
    const descRaw = field(item, "description");
    // WordPress 系源(indienova/IGN)在 content:encoded 里带完整图文,优先用
    const richRaw = field(item, "content:encoded") || descRaw;
    let descBlocks;
    if (feed.fullDesc) {
      const html = decode(richRaw);
      const blocks = htmlToBlocks(html).filter((b) => b.t !== "img" || /^https?:/.test(b.v));
      const plain = stripTags(richRaw);
      descBlocks = blocks.some((b) => b.t !== "img") ? blocks : plain ? [{ t: "p", v: plain }] : undefined;
    }
    out.push({
      title,
      summary: stripTags(descRaw).slice(0, 110),
      source: feed.source,
      url: link,
      image: pickImage(item, richRaw),
      isVideo: /\/videos?\//.test(link),
      ts: Date.parse(field(item, "pubDate")) || Date.now(),
      descBlocks,
    });
    if (feed.max && out.length >= feed.max) break;
  }
  return out;
}

/* ---------- 元数据收集:游民星空(无 RSS,走列表 AJAX 接口翻页) ---------- */

async function fetchGamersky(feed) {
  const out = [];
  const seenUrl = new Set();
  for (let page = 1; page <= (feed.pages || 1); page++) {
    try {
      const jsondata = JSON.stringify({
        type: "updatenodelabel",
        isCache: true,
        cacheTime: 60,
        nodeId: "11007", // 新闻频道
        isNodeId: "true",
        page,
      });
      const raw = await get(`https://db2.gamersky.com/LabelJsonpAjax.aspx?callback=cb&jsondata=${encodeURIComponent(jsondata)}`);
      const jsonp = raw.match(/^\s*cb\(([\s\S]*)\)\s*;?\s*$/);
      const html = jsonp ? JSON.parse(jsonp[1]).body || "" : "";
      const lis = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
      for (const li of lis) {
        const a = li.match(/<a class="tt" href="(https:\/\/www\.gamersky\.com\/news\/\d{6}\/\d+\.shtml)"[^>]*>([\s\S]*?)<\/a>/);
        if (!a) continue;
        const url = a[1];
        if (seenUrl.has(url)) continue;
        seenUrl.add(url);
        const title = stripTags(a[2]);
        const img = li.match(/<img src="([^"]+)"/);
        const txt = li.match(/<div class="txt">([\s\S]*?)<\/div>/);
        const time = li.match(/<div class="time">([^<]+)<\/div>/);
        // 列表时间为北京时间,如 "2026-06-10 18:41"
        const ts = time ? Date.parse(time[1].trim().replace(" ", "T") + ":00+08:00") || Date.now() : Date.now();
        out.push({
          title,
          summary: txt ? stripTags(txt[1]).slice(0, 110) : "",
          source: feed.source,
          url,
          image: img ? decode(img[1]) : null,
          isVideo: false,
          ts,
        });
        if (out.length >= feed.max) return out;
      }
    } catch (err) {
      console.error(`游民星空 第${page}页失败: ${err.message}`);
    }
  }
  return out;
}

/* ---------- 元数据收集:3DM(列表页解析,无 RSS) ---------- */

async function fetch3DM(feed) {
  const html = await get("https://www.3dmgame.com/news/");
  const out = [];
  const seenUrl = new Set();
  for (const m of html.matchAll(/<li class="selectpost">([\s\S]*?)<\/li>/g)) {
    const li = m[1];
    const a = li.match(/<a href="(https:\/\/www\.3dmgame\.com\/news\/\d{6}\/\d+\.html)"[^>]*class="bt"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = a[1];
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);
    const img = li.match(/<img[^>]+data-original="([^"]+)"/);
    const txt = li.match(/<div class="miaoshu">([\s\S]*?)<\/div>/);
    const time = li.match(/<span class="time">([^<]+)<\/span>/);
    // 列表时间为北京时间,如 "2026-06-10 21:33:01"
    const ts = time ? Date.parse(time[1].trim().replace(" ", "T") + "+08:00") || Date.now() : Date.now();
    out.push({
      title: stripTags(a[2]),
      summary: txt ? stripTags(txt[1]).slice(0, 110) : "",
      source: feed.source,
      url,
      image: img ? decode(img[1]) : null,
      isVideo: false,
      ts,
    });
    if (feed.max && out.length >= feed.max) break;
  }
  return out;
}

/* ---------- 元数据收集:17173(网游/手游向,列表页解析) ---------- */

async function fetch17173(feed) {
  const html = await get("http://news.17173.com/index.shtml");
  const out = [];
  const seenUrl = new Set();
  // 按 <li class="item"> 整块解析:同一块内含缩略图(懒加载,真实图在
  // <img style="background:url(...)"> 里)与标题(.tit 内的链接)
  for (const m of html.matchAll(/<li class="item"[^>]*>([\s\S]*?)<\/li>/g)) {
    const li = m[1];
    const linkM = li.match(/\/\/news\.17173\.com\/content\/(\d{2})(\d{2})(\d{4})\/\d+\.shtml/);
    if (!linkM) continue;
    const url = "http:" + linkM[0];
    if (seenUrl.has(url)) continue;
    // 标题取 .tit 里的链接文字
    const titleM = li.match(/<div class="tit">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const title = stripTags(titleM ? titleM[1] : "");
    if (!title || title.length < 6) continue;
    seenUrl.add(url);
    // 缩略图:style 里 background:url(...) 的真实地址(保留 !a-3-240x 缩略后缀,更小更快)
    const imgM = li.match(/background:\s*url\((?:https?:)?(\/\/i\.17173cdn\.com[^)\s"']+)/);
    const mm = String(linkM[1]).padStart(2, "0"), dd = linkM[2], yyyy = linkM[3];
    const dayTs = Date.parse(`${yyyy}-${mm}-${dd}T12:00:00+08:00`) || Date.now();
    out.push({
      title,
      summary: "",
      source: feed.source,
      url,
      image: imgM ? "https:" + imgM[1] : null,
      isVideo: false,
      ts: dayTs + (200 - out.length) * 60000,
    });
    if (feed.max && out.length >= feed.max) break;
  }
  return out;
}

/* ---------- 元数据收集:游侠网(列表页解析,无 RSS) ---------- */

async function fetchYouxia(feed) {
  const html = await get("https://www.ali213.net/news/");
  const out = [];
  const seenUrl = new Set();
  // 列表项:<a class="item ..." href="...news/html/YYYY-M/NNN.html" title="标题"> 内含
  // <img data-original> 缩略图、<div class="i3">YYYY/M/D</div> 日期、<div class="desbox"><p>摘要</p></div>
  for (const m of html.matchAll(/<a class="item[^"]*"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1];
    const block = m[2];
    const hrefM = attrs.match(/href="(https:\/\/www\.ali213\.net\/news\/html\/\d{4}-\d{1,2}\/\d{5,}\.html)"/);
    if (!hrefM) continue; // 跳过游戏库/专题等非新闻 item
    const url = hrefM[1];
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);
    const titleM = attrs.match(/title="([^"]*)"/);
    const title = titleM ? decode(titleM[1]).trim() : "";
    if (!title) continue;
    const img = block.match(/data-original="([^"]+)"/);
    const desM = block.match(/<div class="desbox">\s*<p>([\s\S]*?)<\/p>/);
    const dM = block.match(/<div class="i3">\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*<\/div>/);
    // 列表仅给到日期(无时分):取北京当天中午;同日条目按列表顺序(新→旧)在当天内微调次序
    let ts;
    if (dM) {
      const day = `${dM[1]}-${String(dM[2]).padStart(2, "0")}-${String(dM[3]).padStart(2, "0")}`;
      ts = (Date.parse(`${day}T12:00:00+08:00`) || Date.now()) + (200 - out.length) * 30000;
    } else {
      ts = Date.now();
    }
    out.push({
      title,
      summary: desM ? stripTags(desM[1]).slice(0, 110) : "",
      source: feed.source,
      url,
      image: img ? decode(img[1]) : null,
      isVideo: false,
      ts,
    });
    if (feed.max && out.length >= feed.max) break;
  }
  return out;
}

/* ---------- 元数据收集:A9VG(主机向,列表页解析) ---------- */

async function fetchA9vg(feed) {
  const html = await get("https://www.a9vg.com/list/news");
  const out = [];
  const seenUrl = new Set();
  // 卡片:<a href="/article/NNN" class="vd-card a9-rich-card-list_item ..."> 内含
  // <img class="a9-rich-card-list_image" alt src> 缩略图、<div class="...a9-rich-card-list_label...">标题</div>、行内 "YYYY-M-D HH:MM" 时间
  for (const m of html.matchAll(/<a\b[^>]*href="(\/article\/\d+)"[^>]*class="[^"]*a9-rich-card-list_item[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = "https://www.a9vg.com" + m[1];
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);
    const block = m[2];
    const imgTag = (block.match(/<img\b[^>]*a9-rich-card-list_image[^>]*>/) || block.match(/<img\b[^>]*>/) || [""])[0];
    const srcM = imgTag.match(/src="([^"]+)"/);
    let image = srcM ? decode(srcM[1]) : null;
    if (image && image.startsWith("//")) image = "https:" + image;
    const altM = imgTag.match(/alt="([^"]*)"/);
    const labelM = block.match(/a9-rich-card-list_label[^"]*">\s*([\s\S]*?)<\/div>/);
    const title = labelM ? stripTags(labelM[1]) : altM ? decode(altM[1]).trim() : "";
    if (!title) continue;
    const dM = block.match(/(20\d{2})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    const ts = dM
      ? Date.parse(`${dM[1]}-${String(dM[2]).padStart(2, "0")}-${String(dM[3]).padStart(2, "0")}T${String(dM[4]).padStart(2, "0")}:${dM[5]}:00+08:00`) || Date.now()
      : Date.now();
    out.push({
      title,
      summary: "",
      source: feed.source,
      url,
      image,
      isVideo: false,
      ts,
    });
    if (feed.max && out.length >= feed.max) break;
  }
  return out;
}

/* ---------- 国内一手源:篝火营地(读本地缓存,不联网) ----------
   篝火(gouhuo.qq.com)对海外 IP 地理封锁,Actions 美国节点直连/公共代理均不可达。
   由【国内机器】跑 scripts/fetch-gouhuo.mjs 抓好正文写入 gouhuo-cache.json 并提交,
   本函数只读该缓存把篝火并入信息流(正文已内联在 descBlocks,step5 不再联网抓)。
   缓存缺失或全部过期则返回空(优雅降级,不报错)。 */

function fetchGouhuo(feed) {
  let cache;
  try {
    cache = JSON.parse(readFileSync(new URL("./gouhuo-cache.json", import.meta.url), "utf8"));
  } catch {
    return [];
  }
  const cutoff = Date.now() - (feed.recentDays || 14) * 86400000;
  return (cache.items || [])
    .filter((it) => it && it.title && it.ts && it.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, feed.max || 25)
    .map((it) => ({
      title: it.title,
      summary: it.summary || "",
      source: feed.source,
      url: it.url,
      image: it.image || null,
      isVideo: false,
      ts: it.ts,
      descBlocks: Array.isArray(it.content) && it.content.length ? it.content : undefined,
    }));
}

/* ---------- 官方源:Steam 新闻 API(无需密钥,一手公告/更新) ---------- */

// 追踪的 appid(主流单机/3A/服务型 + 国产标杆),只展示近三周有更新的
const STEAM_APPS = [
  730, 570, 578080, 1245620, 2358720, 1086940, 1091500, 292030, 1174180, 271590,
  990080, 1593500, 2050650, 1817190, 1888930, 1030300, 413150, 1145360, 1599340,
  553850, 381210, 1948280, 1716740, 1086940, 489830, 1817070, 2767030, 1144200,
];

const STEAM_CLAN_IMG = "https://clan.cloudflare.steamstatic.com/images";
const stripBB = (s) => decode((s || "").replace(/\[\/?[a-z*][^\]]*\]/gi, " ")).replace(/\s+/g, " ").trim();

function steamBlocks(raw) {
  const s = (raw || "").replace(/\{STEAM_CLAN_IMAGE\}/g, STEAM_CLAN_IMG);
  const blocks = [];
  const re = /\[img\]([^\[\]]+)\[\/img\]|\[p\]([\s\S]*?)\[\/p\]/gi;
  const pushImg = (u) => {
    u = (u || "").trim();
    if (u.startsWith("//")) u = "https:" + u;
    if (/^https?:\/\//.test(u)) blocks.push({ t: "img", v: u });
  };
  let m;
  while ((m = re.exec(s)) && blocks.length < 40) {
    if (m[1] != null) pushImg(m[1]);
    else {
      const inner = m[2] || "";
      for (const im of inner.matchAll(/\[img\]([^\[\]]+)\[\/img\]/gi)) pushImg(im[1]);
      const txt = stripBB(inner);
      if (txt) blocks.push({ t: "p", v: txt });
    }
  }
  return blocks;
}

async function fetchSteam(feed) {
  const cutoff = Date.now() - 21 * 86400000;
  const lists = await Promise.all(
    [...new Set(STEAM_APPS)].map(async (appid) => {
      try {
        const raw = await get(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=2&maxlength=0&l=schinese`);
        return (JSON.parse(raw).appnews?.newsitems || []).map((n) => ({ ...n, appid }));
      } catch {
        return [];
      }
    })
  );
  const out = [];
  const seen = new Set();
  for (const n of lists.flat()) {
    const ts = (n.date || 0) * 1000;
    if (ts < cutoff || !n.title || seen.has(n.gid)) continue;
    seen.add(n.gid);
    const blocks = steamBlocks(n.contents);
    const plain = blocks.filter((b) => b.t !== "img").map((b) => b.v).join(" ");
    if (plain.length < 20) continue;
    out.push({
      title: stripBB(n.title),
      summary: plain.slice(0, 110),
      source: feed.source,
      official: true,
      url: n.url,
      image: blocks.find((b) => b.t === "img")?.v || null,
      isVideo: false,
      ts,
      descBlocks: blocks,
    });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, feed.max);
}

// 供给量全面放开:RSS 取整源,游民翻 6 页,3DM 整页(约 20 条,站点无近期翻页),
// 17173 加深;再补 PC/PS/Switch 三家平台向英文源(自动翻译),扩大覆盖广度。
const FEEDS = [
  { source: "游民星空", fetcher: fetchGamersky, pages: 6, max: 110 },
  { source: "3DM", fetcher: fetch3DM, max: 60 },
  { source: "游侠网", fetcher: fetchYouxia, max: 50 },
  { source: "A9VG", fetcher: fetchA9vg, max: 30 },
  { source: "篝火营地", fetcher: fetchGouhuo, max: 25, recentDays: 14 },
  { source: "机核", fetcher: fetchRss, url: "https://www.gcores.com/rss", skip: /\/radios\// },
  { source: "游研社", fetcher: fetchRss, url: "https://www.yystv.cn/rss/feed" },
  { source: "触乐", fetcher: fetchRss, url: "http://www.chuapp.com/feed" },
  { source: "17173", fetcher: fetch17173, max: 40 },
  { source: "indienova", fetcher: fetchRss, url: "https://indienova.com/feed/", fullDesc: true },
  { source: "IGN", fetcher: fetchRss, url: "https://feeds.ign.com/ign/games-all", fullDesc: true },
  { source: "GameSpot", fetcher: fetchRss, url: "https://www.gamespot.com/feeds/game-news/", fullDesc: true },
  { source: "PC Gamer", fetcher: fetchRss, url: "https://www.pcgamer.com/rss/", fullDesc: true, max: 12 },
  { source: "Push Square", fetcher: fetchRss, url: "https://www.pushsquare.com/feed", fullDesc: true, max: 10 },
  { source: "Nintendo Life", fetcher: fetchRss, url: "https://www.nintendolife.com/feed", fullDesc: true, max: 10 },
  { source: "Steam", fetcher: fetchSteam, max: 10 },
];

// 同题去重时的来源优先级:中文源有全文优先保留;英文/官方源需翻译,略降
const PRIORITY = { 游民星空: 0, "3DM": 0, 游侠网: 0, A9VG: 0, 篝火营地: 0, 机核: 0, 游研社: 0, 触乐: 0, "17173": 0, indienova: 0, IGN: 1, GameSpot: 1, "PC Gamer": 1, "Push Square": 1, "Nintendo Life": 1, Steam: 1 };

/* ---------- 全文提取 ---------- */

// 占位图特征:懒加载站点 src 常先放 1x1/空白/loading 图,真图在 data-* 属性里
const PLACEHOLDER_IMG = /blank\.(png|gif|jpe?g)|loading|placeholder|grey\.gif|spacer|1x1\.|data:image/i;

// 从单个 <img> 标签里挑出"真实大图":懒加载属性优先于占位 src
function pickImgUrl(tag) {
  const attrs = ["data-large", "data-origin", "sourceimageurl", "data-original", "data-src", "contentimageurl", "original", "zoomfile", "file", "src"];
  for (const a of attrs) {
    const m = tag.match(new RegExp(a + '\\s*=\\s*["\']([^"\']+)["\']', "i"));
    if (m && m[1] && !PLACEHOLDER_IMG.test(m[1])) return decode(m[1]);
  }
  const s = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i); // 全是占位也退回 src
  return s ? decode(s[1]) : null;
}

// HTML 片段 → 结构化块:按出现顺序提取段落与图片
function htmlToBlocks(html) {
  // 先剥离脚本/样式,避免 JS 模板代码、CSS 漏进正文
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const blocks = [];
  const re = /<(p|h[23])[^>]*>([\s\S]*?)<\/\1>|(<img[^>]+>)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[3]) {
      const u = pickImgUrl(m[3]);
      if (u) blocks.push({ t: "img", v: u });
    } else {
      const inner = m[2];
      for (const im of inner.matchAll(/<img[^>]+>/gi)) {
        const u = pickImgUrl(im[0]);
        if (u) blocks.push({ t: "img", v: u });
      }
      const text = stripTags(inner);
      if (text) blocks.push({ t: m[1].toLowerCase() === "p" ? "p" : "h", v: text });
    }
  }
  return blocks;
}

// 站点正文容器(捕获组 1 为正文 HTML;结束标记不命中会吞进页脚广告,务必齐全)
const CONTAINERS = {
  "17173.com": /<div class="gb-final-mod-article[^"]*"[^>]*>([\s\S]*?)(?:gb-final-pn|gb-final-mod-recommend|猜你喜欢|class="mod-side-qrcode|class="mod-share|免责声明|<footer|$)/,
  "3dmgame.com": /<div class="news_warp_center">([\s\S]*?)(?:class="bq|<footer|$)/,
  // 游侠网正文在 <div class="n_show box-shadow" id="Content">;翻页脚本/精品专栏/上下篇/评论块作结束标记
  "ali213.net": /<div class="n_show[^"]*"\s+id="Content">([\s\S]*?)(?:page-break-after|<div class="jpzl|<div class="news_gt|<div class="ng_pl|责任编辑|<footer|$)/,
  // A9VG 正文在 <div class="c-article-main_contentraw">;标签/互动/评论区作结束标记
  "a9vg.com": /<div class="c-article-main_contentraw">([\s\S]*?)(?:<div class="[^"]*c-article-main_tag|<div class="[^"]*c-article-main_behavior|<div class="[^"]*c-comment|<footer|$)/,
  // A9VG 部分 /article/N 实为社区(Discuz 论坛)贴的跳转,正文在首楼 <td class="t_f" id="postmessage_N">
  "bbs.a9vg.com": /<td[^>]*id="postmessage_\d+"[^>]*>([\s\S]*?)(?:<div class="pstl|<div id="comment|<div class="pattl|<dl class="bbda|<div class="tip\b|<\/td>)/,
  "gamersky.com": /<div class="Mid2L_con">([\s\S]*?)(?:<span id="pe100_page_contentpage|<!--文章内容导航|<a class="diggBtn|<div class="Mid2L_extra|$)/,
  // 游民社区(club)话题贴:部分"趣闻/话题"新闻只是个跳转壳,真身在这里
  "club.gamersky.com": /<div class="qzcmt-content-txt GSContent">([\s\S]*?)(?:<div class="qzcmt-bot1|<div class="qzcmt-action|<\/div>\s*<\/div>\s*<div|$)/,
  "yystv.cn": /<div class="doc-content[^"]*"[^>]*>([\s\S]*?)(?:class="article-links-container|class="qrcode-block|class="doc-share|class="footer|<footer|$)/,
  "chuapp.com": /<div class="the-content[^"]*"[^>]*>([\s\S]*?)(?:<!--end-->|<!--评论start|相关文章|<footer|$)/,
};

// 提取失败/无效时返回 null,App 端回退为摘要+原文链接
async function extractContent(item) {
  try {
    // 机核:SPA 页面无正文,走官方 JSON API(draft-js 块结构)
    const gcores = item.url.match(/gcores\.com\/articles\/(\d+)/);
    if (gcores) {
      const res = await fetch(`https://www.gcores.com/gapi/v1/articles/${gcores[1]}`, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const content = JSON.parse(j.data.attributes.content);
      const blocks = [];
      for (const b of content.blocks || []) {
        if (b.type === "atomic") {
          for (const er of b.entityRanges || []) {
            const ent = content.entityMap?.[String(er.key)];
            const p = ent && ent.type === "IMAGE" && ent.data && (ent.data.path || ent.data.src);
            if (p) blocks.push({ t: "img", v: /^https?:/.test(p) ? p : `https://image.gcores.com/${p}` });
          }
        } else if (/header/.test(b.type) && b.text?.trim()) {
          blocks.push({ t: "h", v: b.text.trim() });
        } else if (b.text?.trim() && b.text.trim() !== "-") {
          blocks.push({ t: "p", v: b.text.trim() });
        }
      }
      return finalizeBlocks(blocks);
    }

    // 取最具体(最长)的匹配域名:club.gamersky.com 必须胜过 gamersky.com
    const matchDomain = (u) => Object.keys(CONTAINERS).filter((d) => u.includes(d)).sort((a, b) => b.length - a.length)[0];
    const domain = matchDomain(item.url);
    if (!domain) {
      // IGN / GameSpot 等:文章页抓不到,退而用 RSS 导语段落
      return item.descBlocks ? finalizeBlocks(item.descBlocks) : null;
    }
    let url = item.url;
    let html = await get(url);

    // 游民星空:部分"趣闻/话题"条目的新闻页只是个 JS 跳转壳(<div id="redirectTips" data-link=...>),
    // 真正的图文在游民社区(club.gamersky.com)的话题贴里 —— 跟着 data-link 再抓一次
    if (domain === "gamersky.com") {
      const redir = html.match(/id="redirectTips"[^>]*\bdata-link\s*=\s*["']([^"']+)["']/i);
      if (redir && /gamersky\.com/i.test(redir[1])) {
        url = decode(redir[1]);
        html = await get(url);
      }
    }

    // A9VG:部分 /article/N 是社区贴的跳转(get 已跟随 302 到 bbs.a9vg.com),按 Discuz 首楼容器提取
    if (domain === "a9vg.com" && !html.includes("c-article-main_contentraw") && /postmessage_\d+/.test(html)) {
      const bm = html.match(CONTAINERS["bbs.a9vg.com"]);
      if (!bm) return null;
      // Discuz 首楼是 <br> 分隔的纯文本(无 <p>),先转成段落再走通用块解析
      const pseudo = "<p>" + bm[1].replace(/(<br\s*\/?>\s*)+/gi, "</p><p>") + "</p>";
      return finalizeBlocks(htmlToBlocks(pseudo));
    }

    const cdomain = matchDomain(url) || domain;
    const m = html.match(CONTAINERS[cdomain]);
    if (!m) return null;
    return finalizeBlocks(htmlToBlocks(m[1]));
  } catch (err) {
    console.error(`全文提取失败 ${item.source} ${item.url}: ${err.message}`);
    return null;
  }
}

const BOILERPLATE = /(本文由游民星空|更多相关资讯请关注|转载请注明|责任编辑|关注游民星空|点击进入专题|友情提示：支持键盘|点此前往|游民星空APP|随时掌握游戏情报|出版物经营许可证|京ICP备|京公网安备|人喜欢$|猜你喜欢|点此进入|点击查看更多|怀旧频道|>>>|<<<|\.text\(\)|gb-final-|This story is developing|Sign up for|Subscribe to our|Got a news tip)/i;

function finalizeBlocks(blocks) {
  const out = [];
  let textLen = 0;
  let imgCount = 0;
  for (const b of blocks) {
    if (out.length >= MAX_BLOCKS) break;
    if (b.t === "img") {
      if (imgCount >= MAX_IMGS) continue;
      if (b.v.startsWith("//")) b.v = "https:" + b.v; // 协议相对路径(17173 等)
      if (!/^https?:\/\//.test(b.v)) continue;
      // 站点装饰图/二维码/头像等非内容图
      if (/static\/pages\/|author_cover|avatar|qrcode|loading\.gif|\.gif\?|logo/i.test(b.v)) continue;
      // 游民图集缩略图(/image2026/06/.../NN_S.jpg)升级为原图(同名去 _S/_B 后缀即全尺寸)
      b.v = b.v.replace(/(\/image\d{4}\/\d{2}\/[^"'\s]*?\/\d+)_[SB](\.jpg)/i, "$1$2");
      imgCount++;
      out.push({ t: "img", v: httpsImage(b.v.replace(/["'\\]/g, "")) });
    } else {
      const v = b.v.replace(/\s+/g, " ").trim();
      if (!v || BOILERPLATE.test(v)) continue;
      if (textLen >= MAX_TEXT) continue;
      textLen += v.length;
      out.push({ t: b.t, v });
    }
  }
  // 正文够长,或是图集(纯图、3 张以上)即视为有效提取
  return textLen >= 50 || imgCount >= 3 ? out : null;
}

// 清洗已有(可能来自旧缓存的)正文块:剔除后来才加入黑名单的垃圾块
function cleanContent(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  const out = blocks.filter((b) => b && (b.t === "img" ? true : !BOILERPLATE.test(b.v || "")));
  return out.length ? out : null;
}

/* ---------- 英文内容翻译(Google 免费接口,无需密钥;Actions 美国节点可达) ---------- */

async function translate(text) {
  const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const out = (j[0] || []).map((seg) => seg && seg[0]).filter(Boolean).join("");
  return out || text;
}

// 中文字符占比低于 15% 视为英文内容
const isEnglish = (s) => {
  const zh = (s.match(/[一-鿿]/g) || []).length;
  return zh / Math.max(1, s.length) < 0.15;
};

/* ---------- 分类 ---------- */

function categorize(text) {
  if (/(手游|移动端|mobile game|TapTap|App ?Store|GooglePlay|开启预约|公测|内测|封测|抽卡|卡池|二次元|二游(?!戏)|原神|崩坏|星穹铁道|崩铁|绝区零|鸣潮|明日方舟|王者荣耀|和平精英|金铲铲|蛋仔|恋与深空|恋与制作人|无限暖暖|碧蓝航线|碧蓝档案|蔚蓝档案|FGO|公主连结|阴阳师|第五人格|光遇|尘白禁区|少女前线|战双|深空之眼|重返未来|白夜极光|雀魂|米哈游|米游社|库洛|鹰角|叠纸|莉莉丝|散爆|世界之外|如鸢|无期迷途|偶像梦幻祭)/i.test(text)) return "手游";
  if (/(PS5|PS4|PlayStation|Xbox|Switch|任天堂|Nintendo|主机|塞尔达|马里奥|console)/i.test(text)) return "主机";
  if (/(Steam|Epic|PC ?版|显卡|GOG|模组|\bMod\b|\bPC\b)/i.test(text)) return "PC";
  return "业界";
}

/* ---------- 主流程 ---------- */

const collected = await Promise.all(
  FEEDS.map(async (f) => {
    try {
      const items = await f.fetcher(f);
      console.log(`${f.source}: ${items.length} 条`);
      return items;
    } catch (err) {
      console.error(`${f.source} 抓取失败: ${err.message}`);
      return [];
    }
  })
);

// 1) 粗去重(同标题前缀),不设数量上限
const seen = new Set();
const candidates = collected
  .flat()
  .sort((a, b) => b.ts - a.ts)
  .filter((n) => {
    const k = n.title.slice(0, 24);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

if (candidates.length < 5) {
  console.error(`仅抓到 ${candidates.length} 条,保留原 news.json 不更新`);
  process.exit(0);
}

// 1.5) 复用归档里的全文与译文(供给量放开后,避免每轮重复抓文章页/重复翻译)
const dayOfTs = (ts) => new Date((ts || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const contentCache = new Map(); // url/title → 全文块
const transCache = new Map(); // 英文原题 → { title, summary }
for (const day of new Set(candidates.map((n) => dayOfTs(n.ts)))) {
  try {
    const arc = JSON.parse(readFileSync(new URL(`../archive/${day}.json`, import.meta.url), "utf8"));
    for (const it of arc.items || []) {
      const k = it.url || it.title;
      if (it.content) contentCache.set(k, it.content);
      if (it.titleEn) transCache.set(it.titleEn, { title: it.title, summary: it.summary });
    }
  } catch {}
}

// 2) 英文条目先译标题/摘要(原题存 titleEn)——跨语言查重需要中文标题可比
let translated = 0;
let transCached = 0;
for (const n of candidates) {
  if (!isEnglish(n.title)) continue;
  const cached = transCache.get(n.title);
  if (cached && cached.title) {
    n.titleEn = n.title;
    n.title = cached.title;
    if (cached.summary) n.summary = cached.summary;
    transCached++;
    continue;
  }
  try {
    n.titleEn = n.title;
    n.title = await translate(n.title);
    if (n.summary && isEnglish(n.summary)) n.summary = (await translate(n.summary)).slice(0, 120);
    translated++;
  } catch (err) {
    delete n.titleEn;
    console.error(`翻译失败(保留英文): ${err.message}`);
  }
}
console.log(`英文翻译:新译 ${translated} 条,复用 ${transCached} 条`);

// 3) 同一事件跨来源查重:标题二元组相似度 + 《游戏名》共现,优先保留中文源
const normT = (t) => t.toLowerCase().replace(/[^一-鿿a-z0-9]/g, "");
const bigrams = (s) => {
  const o = new Set();
  for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2));
  return o;
};
const overlap = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
};
const gameNames = (t) => [...t.matchAll(/《([^》]+)》/g)].map((m) => normT(m[1]));
// 日期/平台/发售套话会虚抬相似度,数字与"官宣/突破"类同义异形词会压低相似度,比较前统一剥掉
const BOILER_RE = /(将于|正式|登陆|发售|公布|宣布|确认|推出|上线|预购|开启|即将|官方|官宣|致谢|发文|突破|曝|nintendoswitch2?|switch2?|playstation|ps5|ps4|xboxseries|xbox|steam|\d+)/g;
// 游戏名归一:《生化危机RE:维罗妮卡》《生化:维罗妮卡RE》视为同名
const normName = (s) => s.replace(/(remake|re|hd|重制版|代号)/gi, "");
function namesMatch(na, nb) {
  for (const a of na)
    for (const b of nb) {
      const x = normName(a), y = normName(b);
      if (x.length < 2 || y.length < 2) continue;
      if (x === y || x.includes(y) || y.includes(x)) return true;
      if (overlap(x, y) >= 0.6) return true;
    }
  return false;
}
function sameStory(a, b) {
  const na = gameNames(a.title), nb = gameNames(b.title);
  if (na.length && nb.length && namesMatch(na, nb)) {
    // 同一游戏且 36 小时内:先移除游戏名(原形+归一形),再剥套话,比较剩余表述
    if (Math.abs((a.ts || 0) - (b.ts || 0)) > 36 * 3600 * 1000) return false;
    let ra = normT(a.title);
    let rb = normT(b.title);
    for (const n of [...na, ...nb]) {
      for (const v of [n, normName(n)]) {
        if (v.length >= 2) {
          ra = ra.split(v).join("");
          rb = rb.split(v).join("");
        }
      }
    }
    ra = ra.replace(BOILER_RE, "");
    rb = rb.replace(BOILER_RE, "");
    if (ra.length < 4 && rb.length < 4) return true;
    return overlap(ra, rb) >= 0.25;
  }
  const sa = normT(a.title).replace(BOILER_RE, "");
  const sb = normT(b.title).replace(BOILER_RE, "");
  if (sa.length < 4 || sb.length < 4) return false;
  return overlap(sa, sb) >= 0.6;
}

const ranked = [...candidates].sort(
  (x, y) => (PRIORITY[x.source] ?? 1) - (PRIORITY[y.source] ?? 1) || y.ts - x.ts
);
const winners = [];
for (const c of ranked) {
  const dup = winners.find((w) => sameStory(w, c));
  if (dup) {
    // 多源同报 = 热点信号:记录在保留版本上
    dup.hotSources ||= [dup.source];
    if (!dup.hotSources.includes(c.source)) dup.hotSources.push(c.source);
    dup.hot = dup.hotSources.length;
    // 保留落败源的可跳转报道(供客户端"各家怎么说"面板),按源去重、限量
    dup.others ||= [];
    if (c.url && !dup.others.some((o) => o.source === c.source) && dup.source !== c.source) {
      dup.others.push({ source: c.source, url: c.url, title: c.title, ts: c.ts });
      if (dup.others.length > 6) dup.others.length = 6;
    }
    console.log(`同题剔除: [${c.source}] ${c.title.slice(0, 28)} ≈ [${dup.source}] ${dup.title.slice(0, 28)}`);
    continue;
  }
  winners.push(c);
}

// 4) 按时间排序定稿(无数量上限,有多少放多少)
const news = winners
  .sort((a, b) => b.ts - a.ts)
  .map((n, i) => {
    let cat = categorize(n.title + " " + n.summary);
    if (n.source === "Steam" && cat === "业界") cat = "PC"; // Steam 公告默认归 PC
    return { id: i + 1, category: cat, ...n, image: httpsImage(n.image) };
  });

// 5) 并发提取全文(限流;已归档过的直接复用)
let cursor = 0;
let fullCount = 0;
let contentCached = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < news.length) {
      const item = news[cursor++];
      const cached = contentCache.get(item.url || item.title);
      // RSS 自带的全文零成本,总是重新计算;比缓存更全(块数多)就升级
      const fresh = item.descBlocks ? finalizeBlocks(item.descBlocks) : null;
      if (fresh && (fresh.length > (cached?.length || 0))) {
        item.content = fresh;
      } else if (cached) {
        item.content = cached;
        contentCached++;
      } else {
        item.content = await extractContent(item);
      }
      item.content = cleanContent(item.content); // 清洗旧缓存里的垃圾块
      if (item.content) fullCount++;
      delete item.descBlocks; // 中间数据不写入 news.json
    }
  })
);
console.log(`全文提取:${fullCount}/${news.length}(其中复用归档 ${contentCached})`);

// 6) 英文条目的正文译为中文:整篇分块批量翻译(换行分隔还原),
//    译文段数对不上时回退逐段,失败保留英文
async function translateBlocks(blocks) {
  const texts = blocks.filter((b) => b.t !== "img" && isEnglish(b.v));
  let batch = [];
  let len = 0;
  const flush = async () => {
    if (!batch.length) return;
    const src = batch.map((b) => b.v).join("\n");
    try {
      const out = (await translate(src)).split("\n");
      if (out.length === batch.length) {
        batch.forEach((b, i) => (b.v = out[i].trim() || b.v));
      } else {
        for (const b of batch) {
          try {
            b.v = await translate(b.v);
          } catch {}
        }
      }
    } catch {}
    batch = [];
    len = 0;
  };
  for (const b of texts) {
    if (len + b.v.length > 1600) await flush();
    batch.push(b);
    len += b.v.length;
  }
  await flush();
}

for (const n of news) {
  if (!n.titleEn || !n.content) continue;
  await translateBlocks(n.content);
}

/* ---------- AI 主编简报(Claude,每北京日一次) ---------- */

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const pickKey = (n) => n.url || (n.title || "").slice(0, 18);

async function makeDigest(items, prevDigest) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (prevDigest && prevDigest.date === today) return prevDigest; // 每天一次,省 token
  if (!ANTHROPIC_KEY) return prevDigest || null; // 未配置密钥则优雅降级
  const list = items
    .slice(0, 100)
    .map((n) => `[${pickKey(n)}] (${n.source}/${n.category}${n.hot > 1 ? ` 🔥${n.hot}源` : ""}) ${n.title}${n.summary ? " — " + n.summary.slice(0, 50) : ""}`)
    .join("\n");
  const system =
    "你是电玩日报的 AI 主编。读者是一位 AIGC 叙事/世界观创业者,关注游戏行业的结构性信号(行业趋势、技术变革、商业动向、叙事与内容创作方法),而非促销打折类资讯。";
  const prompt =
    `下面是今天抓取到的游戏新闻列表,每行格式:[key] (来源/分类) 标题 — 摘要\n\n${list}\n\n` +
    `请做今天的「主编导读」:\n` +
    `1. overview:一段不超过 140 字的今日行业风向速览,点出今天的主线。\n` +
    `2. picks:挑 3-5 条最值得这位创作者读的新闻。每条给 key(必须从上面列表方括号里精确复制)、title(该新闻标题)、why(一句话说明为何对叙事/世界观创业者值得读)。优先结构性信号与行业变化,淡化单纯促销。`;
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["overview", "picks"],
    properties: {
      overview: { type: "string" },
      picks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "title", "why"],
          properties: { key: { type: "string" }, title: { type: "string" }, why: { type: "string" } },
        },
      },
    },
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 3000,
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema } },
        system,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    const text = (j.content || []).find((b) => b.type === "text")?.text;
    const parsed = JSON.parse(text);
    const picks = (parsed.picks || []).filter((p) => p && p.key && p.title && p.why).slice(0, 5);
    if (!picks.length) throw new Error("无有效 picks");
    console.log(`主编简报:${picks.length} 条精选`);
    return { date: today, generatedAt: new Date().toISOString(), overview: parsed.overview || "", picks };
  } catch (err) {
    console.error(`主编简报失败(保留旧版): ${err.message}`);
    return prevDigest || null;
  }
}

let prevDigest = null;
try {
  prevDigest = JSON.parse(readFileSync(new URL("../news.json", import.meta.url), "utf8")).digest || null;
} catch {}
const digest = await makeDigest(news, prevDigest);

const flash = news.slice(0, 24).map((n) => ({ ts: n.ts, text: n.title, id: n.id }));

// news.json 瘦身:仅最新 30 条内联全文(最常被点开),
// 瘦身已回滚:国内访问归档/代理不稳定,全文全部内联,可靠性优先于流量

// 各源抓取健康度,App「我的」页可见
const sources = Object.fromEntries(FEEDS.map((f, i) => [f.source, (collected[i] || []).length]));

writeFileSync(
  new URL("../news.json", import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), sources, digest, news, flash }),
  "utf8"
);
console.log(`news.json 已生成:${news.length} 条新闻(全文内联)`);

/* ---------- 历史归档:按北京日期累积,供 App 下滑加载更早新闻 ---------- */

const ARCHIVE_DIR = new URL("../archive/", import.meta.url);
mkdirSync(ARCHIVE_DIR, { recursive: true });
const dayOf = (ts) => new Date((ts || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);

const byDay = {};
for (const n of news) (byDay[dayOf(n.ts)] ||= []).push(n);

for (const [day, items] of Object.entries(byDay)) {
  const file = new URL(`${day}.json`, ARCHIVE_DIR);
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(file, "utf8")).items || [];
  } catch {}
  const map = new Map();
  for (const it of [...existing, ...items]) {
    const k = it.url || it.title;
    const prev = map.get(k);
    // 同条新闻保留全文块数更多的版本(解析改进后能升级旧归档)
    const content = cleanContent(
      (it.content?.length || 0) >= (prev?.content?.length || 0) ? it.content : prev.content
    );
    const { id, ...rest } = { ...prev, ...it, content: content || null };
    map.set(k, rest);
  }
  // 归档内同题去重:跨轮次保留的"同事件不同来源版本"在此合并(来源计入热点)
  const sorted = [...map.values()].sort((a, b) => b.ts - a.ts);
  const merged = [];
  for (const it of sorted) {
    const dup = merged.find((w) => sameStory(w, it));
    if (dup) {
      dup.hotSources ||= [dup.source];
      if (!dup.hotSources.includes(it.source)) dup.hotSources.push(it.source);
      dup.hot = dup.hotSources.length;
      if ((it.content?.length || 0) > (dup.content?.length || 0)) dup.content = it.content;
      // 累积各家报道(合并双方已有的 others + 落败条目自身)
      dup.others ||= [];
      const merge = [...(it.others || []), { source: it.source, url: it.url, title: it.title, ts: it.ts }];
      for (const o of merge) {
        if (o.url && o.source !== dup.source && !dup.others.some((x) => x.source === o.source)) dup.others.push(o);
      }
      if (dup.others.length > 6) dup.others.length = 6;
      continue;
    }
    merged.push(it);
  }
  // 内容无变化不写盘:避免每轮重写全部归档文件造成 git 历史膨胀
  const out = JSON.stringify({ date: day, items: merged });
  let prevRaw = null;
  try {
    prevRaw = readFileSync(file, "utf8");
  } catch {}
  if (prevRaw !== out) writeFileSync(file, out, "utf8");
}

// 索引(日期倒序)+ 清理 90 天前的归档
const pruneBefore = dayOf(Date.now() - 90 * 86400000);
const allDates = readdirSync(ARCHIVE_DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.slice(0, 10));
for (const d of allDates.filter((d) => d < pruneBefore)) unlinkSync(new URL(`${d}.json`, ARCHIVE_DIR));
const dates = allDates.filter((d) => d >= pruneBefore).sort().reverse();
const idxOut = JSON.stringify(dates);
let idxPrev = null;
try {
  idxPrev = readFileSync(new URL("index.json", ARCHIVE_DIR), "utf8");
} catch {}
if (idxPrev !== idxOut) writeFileSync(new URL("index.json", ARCHIVE_DIR), idxOut, "utf8");
console.log(`归档完成:本轮 ${Object.keys(byDay).sort().join(", ")},可翻 ${dates.length} 天`);
