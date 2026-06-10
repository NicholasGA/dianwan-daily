/* ============================================================
   电玩日报 — 新闻抓取脚本(GitHub Actions 定时运行)
   1) 从各游戏媒体收集新闻(RSS / 列表页解析)
   2) 进入每篇文章页提取全文(文字+配图的结构化块),App 内直接阅读
   生成 news.json。无第三方依赖,Node 18+ 自带 fetch。
   ============================================================ */

import { writeFileSync } from "node:fs";

const MAX_TOTAL = 60;
const PER_SOURCE_CAP = 18; // 单一来源不挤占整个列表
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
const httpsImage = (u) => (u && u.startsWith("http://") ? `https://wsrv.nl/?url=${encodeURIComponent(u.slice(7))}` : u);

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
    out.push({
      title,
      summary: stripTags(descRaw).slice(0, 110),
      source: feed.source,
      url: link,
      image: pickImage(item, descRaw),
      isVideo: /\/videos?\//.test(link),
      ts: Date.parse(field(item, "pubDate")) || Date.now(),
    });
    if (out.length >= feed.max) break;
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

const FEEDS = [
  { source: "游民星空", fetcher: fetchGamersky, pages: 2, max: 40 }, // 新闻频道第 1-2 页全量
  { source: "机核", fetcher: fetchRss, url: "https://www.gcores.com/rss", skip: /\/radios\//, max: 15 },
  { source: "游研社", fetcher: fetchRss, url: "https://www.yystv.cn/rss/feed", max: 15 },
  { source: "触乐", fetcher: fetchRss, url: "http://www.chuapp.com/feed", max: 15 },
  { source: "IGN", fetcher: fetchRss, url: "https://feeds.ign.com/ign/games-all", max: 8 },
  { source: "GameSpot", fetcher: fetchRss, url: "https://www.gamespot.com/feeds/game-news/", max: 8 },
];

/* ---------- 全文提取 ---------- */

// HTML 片段 → 结构化块:按出现顺序提取段落与图片
function htmlToBlocks(html) {
  const blocks = [];
  const re = /<(p|h[23])[^>]*>([\s\S]*?)<\/\1>|<img[^>]+src="([^"]+)"[^>]*\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[3]) {
      blocks.push({ t: "img", v: decode(m[3]) });
    } else {
      const inner = m[2];
      for (const im of inner.matchAll(/<img[^>]+src="([^"]+)"[^>]*\/?>/gi)) {
        blocks.push({ t: "img", v: decode(im[1]) });
      }
      const text = stripTags(inner);
      if (text) blocks.push({ t: m[1].toLowerCase() === "p" ? "p" : "h", v: text });
    }
  }
  return blocks;
}

// 站点正文容器(捕获组 1 为正文 HTML;结束标记不命中会吞进页脚广告,务必齐全)
const CONTAINERS = {
  "gamersky.com": /<div class="Mid2L_con">([\s\S]*?)(?:<span id="pe100_page_contentpage|<!--文章内容导航|<a class="diggBtn|<div class="Mid2L_extra|$)/,
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

    const domain = Object.keys(CONTAINERS).find((d) => item.url.includes(d));
    if (!domain) return null; // IGN / GameSpot 等:不支持全文
    const html = await get(item.url);
    const m = html.match(CONTAINERS[domain]);
    if (!m) return null;
    return finalizeBlocks(htmlToBlocks(m[1]));
  } catch (err) {
    console.error(`全文提取失败 ${item.source} ${item.url}: ${err.message}`);
    return null;
  }
}

const BOILERPLATE = /(本文由游民星空|更多相关资讯请关注|转载请注明|责任编辑|关注游民星空|点击进入专题|友情提示：支持键盘|点此前往|游民星空APP|随时掌握游戏情报|出版物经营许可证|京ICP备|京公网安备|人喜欢$)/;

function finalizeBlocks(blocks) {
  const out = [];
  let textLen = 0;
  let imgCount = 0;
  for (const b of blocks) {
    if (out.length >= MAX_BLOCKS) break;
    if (b.t === "img") {
      if (imgCount >= MAX_IMGS) continue;
      if (!/^https?:\/\//.test(b.v)) continue;
      // 站点装饰图/二维码/头像等非内容图
      if (/static\/pages\/|author_cover|avatar|qrcode|loading\.gif|\.gif\?|logo/i.test(b.v)) continue;
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
  return textLen >= 50 ? out : null; // 正文太短视为提取失败
}

/* ---------- 分类 ---------- */

function categorize(text) {
  if (/(手游|移动端|iOS|安卓|Android|原神|崩坏|鸣潮|明日方舟|王者荣耀|和平精英|二游|抽卡|mobile game)/i.test(text)) return "手游";
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

const seen = new Set();
const perSource = {};
const news = collected
  .flat()
  .sort((a, b) => b.ts - a.ts)
  .filter((n) => {
    const k = n.title.slice(0, 24);
    if (seen.has(k)) return false;
    seen.add(k);
    perSource[n.source] = (perSource[n.source] || 0) + 1;
    return perSource[n.source] <= PER_SOURCE_CAP;
  })
  .slice(0, MAX_TOTAL)
  .map((n, i) => ({ id: i + 1, category: categorize(n.title + " " + n.summary), ...n, image: httpsImage(n.image) }));

if (news.length < 5) {
  console.error(`仅抓到 ${news.length} 条,保留原 news.json 不更新`);
  process.exit(0);
}

// 并发提取全文(限流)
let cursor = 0;
let fullCount = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < news.length) {
      const item = news[cursor++];
      item.content = await extractContent(item);
      if (item.content) fullCount++;
    }
  })
);
console.log(`全文提取成功:${fullCount}/${news.length}`);

const flash = news.slice(0, 12).map((n) => ({ ts: n.ts, text: n.title, id: n.id }));

writeFileSync(
  new URL("../news.json", import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), news, flash }, null, 1),
  "utf8"
);
console.log(`news.json 已生成:${news.length} 条新闻`);
