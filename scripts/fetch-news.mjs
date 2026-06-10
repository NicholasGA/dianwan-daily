/* ============================================================
   电玩日报 — 新闻抓取脚本(GitHub Actions 定时运行)
   1) 从各游戏媒体收集新闻(RSS / 列表页解析)
   2) 进入每篇文章页提取全文(文字+配图的结构化块),App 内直接阅读
   生成 news.json。无第三方依赖,Node 18+ 自带 fetch。
   ============================================================ */

import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";

const MAX_TOTAL = 80;
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
    // 英文站文章页有 Cloudflare 防护抓不到全文,RSS 描述里的导语段落是唯一可用正文
    let descBlocks;
    if (feed.fullDesc) {
      const html = decode(descRaw);
      const blocks = htmlToBlocks(html).filter((b) => b.t !== "img" || /^https?:/.test(b.v));
      const plain = stripTags(descRaw);
      descBlocks = blocks.some((b) => b.t !== "img") ? blocks : plain ? [{ t: "p", v: plain }] : undefined;
    }
    out.push({
      title,
      summary: stripTags(descRaw).slice(0, 110),
      source: feed.source,
      url: link,
      image: pickImage(item, descRaw),
      isVideo: /\/videos?\//.test(link),
      ts: Date.parse(field(item, "pubDate")) || Date.now(),
      descBlocks,
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
    if (out.length >= feed.max) break;
  }
  return out;
}

const FEEDS = [
  { source: "游民星空", fetcher: fetchGamersky, pages: 2, max: 40 }, // 新闻频道第 1-2 页全量
  { source: "3DM", fetcher: fetch3DM, max: 12 },
  { source: "机核", fetcher: fetchRss, url: "https://www.gcores.com/rss", skip: /\/radios\//, max: 15 },
  { source: "游研社", fetcher: fetchRss, url: "https://www.yystv.cn/rss/feed", max: 15 },
  { source: "触乐", fetcher: fetchRss, url: "http://www.chuapp.com/feed", max: 15 },
  { source: "indienova", fetcher: fetchRss, url: "https://indienova.com/feed/", max: 6, fullDesc: true },
  { source: "IGN", fetcher: fetchRss, url: "https://feeds.ign.com/ign/games-all", max: 8, fullDesc: true },
  { source: "GameSpot", fetcher: fetchRss, url: "https://www.gamespot.com/feeds/game-news/", max: 8, fullDesc: true },
];

// 同题去重时的来源优先级:中文源有全文,优先保留
const PRIORITY = { 游民星空: 0, "3DM": 0, 机核: 0, 游研社: 0, 触乐: 0, indienova: 0, IGN: 1, GameSpot: 1 };

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
  "3dmgame.com": /<div class="news_warp_center">([\s\S]*?)(?:class="bq|<footer|$)/,
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
    if (!domain) {
      // IGN / GameSpot 等:文章页抓不到,退而用 RSS 导语段落
      return item.descBlocks ? finalizeBlocks(item.descBlocks) : null;
    }
    const html = await get(item.url);
    const m = html.match(CONTAINERS[domain]);
    if (!m) return null;
    return finalizeBlocks(htmlToBlocks(m[1]));
  } catch (err) {
    console.error(`全文提取失败 ${item.source} ${item.url}: ${err.message}`);
    return null;
  }
}

const BOILERPLATE = /(本文由游民星空|更多相关资讯请关注|转载请注明|责任编辑|关注游民星空|点击进入专题|友情提示：支持键盘|点此前往|游民星空APP|随时掌握游戏情报|出版物经营许可证|京ICP备|京公网安备|人喜欢$|This story is developing|Sign up for|Subscribe to our|Got a news tip)/i;

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
  if (/(手游|移动端|iOS|安卓|Android|原神|崩坏|鸣潮|明日方舟|王者荣耀|和平精英|二游|抽卡|mobile game|TapTap|App Store|开启预约|公测|星穹铁道|绝区零|碧蓝航线|阴阳师|蛋仔)/i.test(text)) return "手游";
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

// 1) 粗去重(同标题前缀)+ 按时间取候选池
const seen = new Set();
const candidates = collected
  .flat()
  .sort((a, b) => b.ts - a.ts)
  .filter((n) => {
    const k = n.title.slice(0, 24);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .slice(0, 90);

if (candidates.length < 5) {
  console.error(`仅抓到 ${candidates.length} 条,保留原 news.json 不更新`);
  process.exit(0);
}

// 2) 英文条目先译标题/摘要(原题存 titleEn)——跨语言查重需要中文标题可比
let translated = 0;
for (const n of candidates) {
  if (!isEnglish(n.title)) continue;
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
console.log(`英文翻译:${translated} 条`);

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
// 日期/平台/发售套话会虚抬相似度("将于2026年X月X日登陆Switch"),比较前剥掉
const BOILER_RE = /(将于|正式|登陆|发售|公布|宣布|确认|推出|上线|预购|开启|即将|nintendoswitch2?|switch2?|playstation|ps5|ps4|xboxseries|xbox|steam|\d+)/g;
function sameStory(a, b) {
  const na = gameNames(a.title), nb = gameNames(b.title);
  const shared = na.find((x) => nb.includes(x));
  if (shared) {
    // 同一游戏:去掉游戏名后比较剩余表述,避免"同游戏不同事"被误合并
    const ra = normT(a.title).split(shared).join("");
    const rb = normT(b.title).split(shared).join("");
    if (ra.length < 4 && rb.length < 4) return true;
    return overlap(ra, rb) >= 0.35;
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
    console.log(`同题剔除: [${c.source}] ${c.title.slice(0, 28)} ≈ [${dup.source}] ${dup.title.slice(0, 28)}`);
    continue;
  }
  winners.push(c);
}

// 4) 按时间排序 + 单源上限 + 总量,定稿
const perSource = {};
const news = winners
  .sort((a, b) => b.ts - a.ts)
  .filter((n) => {
    perSource[n.source] = (perSource[n.source] || 0) + 1;
    return perSource[n.source] <= PER_SOURCE_CAP;
  })
  .slice(0, MAX_TOTAL)
  .map((n, i) => ({ id: i + 1, category: categorize(n.title + " " + n.summary), ...n, image: httpsImage(n.image) }));

// 5) 并发提取全文(限流)
let cursor = 0;
let fullCount = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < news.length) {
      const item = news[cursor++];
      item.content = await extractContent(item);
      if (item.content) fullCount++;
      delete item.descBlocks; // 中间数据不写入 news.json
    }
  })
);
console.log(`全文提取成功:${fullCount}/${news.length}`);

// 6) 英文条目的正文段落译为中文(导语级,段落数少)
for (const n of news) {
  if (!n.titleEn || !n.content) continue;
  for (const b of n.content) {
    if (b.t === "img" || !isEnglish(b.v)) continue;
    try {
      b.v = await translate(b.v);
    } catch {
      /* 保留英文 */
    }
  }
}

const flash = news.slice(0, 16).map((n) => ({ ts: n.ts, text: n.title, id: n.id }));

writeFileSync(
  new URL("../news.json", import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), news, flash }, null, 1),
  "utf8"
);
console.log(`news.json 已生成:${news.length} 条新闻`);

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
    // 同条新闻多次出现时保留信息更全的版本(有全文优先)
    if (!prev || (!prev.content && it.content)) {
      const { id, ...rest } = { ...prev, ...it, content: it.content || prev?.content || null };
      map.set(k, rest);
    }
  }
  const merged = [...map.values()].sort((a, b) => b.ts - a.ts);
  writeFileSync(file, JSON.stringify({ date: day, items: merged }, null, 1), "utf8");
}

// 索引(日期倒序)+ 清理 30 天前的归档
const pruneBefore = dayOf(Date.now() - 30 * 86400000);
const allDates = readdirSync(ARCHIVE_DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.slice(0, 10));
for (const d of allDates.filter((d) => d < pruneBefore)) unlinkSync(new URL(`${d}.json`, ARCHIVE_DIR));
const dates = allDates.filter((d) => d >= pruneBefore).sort().reverse();
writeFileSync(new URL("index.json", ARCHIVE_DIR), JSON.stringify(dates), "utf8");
console.log(`归档完成:本轮 ${Object.keys(byDay).sort().join(", ")},可翻 ${dates.length} 天`);
