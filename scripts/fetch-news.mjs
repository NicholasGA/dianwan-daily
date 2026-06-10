/* ============================================================
   电玩日报 — 新闻抓取脚本(GitHub Actions 定时运行)
   从各游戏媒体 RSS 抓取最新新闻,生成 news.json 供 App 刷新拉取。
   无第三方依赖,Node 18+ 自带 fetch。
   ============================================================ */

import { writeFileSync } from "node:fs";

const FEEDS = [
  { source: "机核", url: "https://www.gcores.com/rss", skip: /\/radios\// },
  { source: "游研社", url: "https://www.yystv.cn/rss/feed" },
  { source: "触乐", url: "http://www.chuapp.com/feed" },
  { source: "IGN", url: "https://feeds.ign.com/ign/games-all" },
  { source: "GameSpot", url: "https://www.gamespot.com/feeds/game-news/" },
];

const MAX_PER_SOURCE = 8;
const MAX_TOTAL = 28;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
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

function categorize(text) {
  if (/(手游|移动端|iOS|安卓|Android|原神|崩坏|鸣潮|明日方舟|王者荣耀|和平精英|二游|抽卡|mobile game)/i.test(text)) return "手游";
  if (/(PS5|PS4|PlayStation|Xbox|Switch|任天堂|Nintendo|主机|塞尔达|马里奥|console)/i.test(text)) return "主机";
  if (/(Steam|Epic|PC ?版|显卡|GOG|模组|\bMod\b|\bPC\b)/i.test(text)) return "PC";
  return "业界";
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (dianwan-daily news bot)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    const out = [];
    for (const item of items) {
      const link = decode(field(item, "link"));
      if (!link || (feed.skip && feed.skip.test(link))) continue;
      const title = stripTags(field(item, "title"));
      if (!title) continue;
      const descRaw = field(item, "description");
      const summary = stripTags(descRaw).slice(0, 110);
      const ts = Date.parse(field(item, "pubDate")) || Date.now();
      out.push({
        title,
        summary,
        source: feed.source,
        url: link,
        image: pickImage(item, descRaw),
        isVideo: /\/videos?\//.test(link),
        category: categorize(title + " " + summary),
        ts,
      });
      if (out.length >= MAX_PER_SOURCE) break;
    }
    console.log(`${feed.source}: ${out.length} 条`);
    return out;
  } catch (err) {
    console.error(`${feed.source} 抓取失败: ${err.message}`);
    return [];
  }
}

const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
const seen = new Set();
const news = all
  .sort((a, b) => b.ts - a.ts)
  .filter((n) => {
    const k = n.title.slice(0, 24);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .slice(0, MAX_TOTAL);

// 抓到的太少(源大面积故障)时保留旧 news.json,不写坏数据
if (news.length < 5) {
  console.error(`仅抓到 ${news.length} 条,保留原 news.json 不更新`);
  process.exit(0);
}

const flash = news.slice(0, 10).map((n) => ({ ts: n.ts, text: n.title, url: n.url }));

writeFileSync(
  new URL("../news.json", import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), news, flash }, null, 1),
  "utf8"
);
console.log(`news.json 已生成:${news.length} 条新闻`);
