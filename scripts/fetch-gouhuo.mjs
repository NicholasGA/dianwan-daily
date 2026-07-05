/* ============================================================
   电玩日报 — 篝火营地(gouhuo.qq.com)本地抓取脚本
   篝火对海外 IP 地理封锁(GitHub Actions 美国节点不可达),
   故不能进主流水线(fetch-news.mjs 在 Actions 上跑)。
   本脚本在【国内机器】上运行,抓好正文写入 scripts/gouhuo-cache.json,
   主流水线的 fetchGouhuo 读该缓存把篝火并入信息流(不再联网抓 gouhuo)。
   建议在国内机器上定时运行本脚本 + git 提交推送 gouhuo-cache.json 保鲜。
   无第三方依赖,Node 18+ 自带 fetch。
   ============================================================ */

import { writeFileSync, readFileSync } from "node:fs";

const MAX_ITEMS = 25;         // 每次最多收录条数
const RECENT_DAYS = 14;       // 只收录近 N 天的文章
const MAX_BLOCKS = 60, MAX_TEXT = 7000, MAX_IMGS = 12;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" };

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", hellip: "…", mdash: "—" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => { if (e[0] === "#") { const c = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; } return ENT[e.toLowerCase()] ?? m; });
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function get(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (err) { if (attempt >= 1) throw err; }
  }
}

const PLACEHOLDER_IMG = /blank\.(png|gif|jpe?g)|loading|placeholder|grey\.gif|spacer|1x1\.|data:image/i;
function pickImgUrl(tag) {
  const attrs = ["data-large", "data-origin", "sourceimageurl", "data-original", "data-src", "contentimageurl", "original", "zoomfile", "file", "src"];
  for (const a of attrs) { const m = tag.match(new RegExp(a + '\\s*=\\s*["\']([^"\']+)["\']', "i")); if (m && m[1] && !PLACEHOLDER_IMG.test(m[1])) return decode(m[1]); }
  const s = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i); return s ? decode(s[1]) : null;
}
function htmlToBlocks(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const blocks = []; const re = /<(p|h[23])[^>]*>([\s\S]*?)<\/\1>|(<img[^>]+>)/gi; let m;
  while ((m = re.exec(html))) {
    if (m[3]) { const u = pickImgUrl(m[3]); if (u) blocks.push({ t: "img", v: u }); }
    else { const inner = m[2]; for (const im of inner.matchAll(/<img[^>]+>/gi)) { const u = pickImgUrl(im[0]); if (u) blocks.push({ t: "img", v: u }); } const text = stripTags(inner); if (text) blocks.push({ t: m[1].toLowerCase() === "p" ? "p" : "h", v: text }); }
  }
  return blocks;
}
const BOILERPLATE = /(全部评论|您还未|不能参与发言|转载请注明|责任编辑|备案号|COPYRIGHT|TENCENT|扫码|二维码|关注我们|点击查看更多)/i;
function finalizeBlocks(blocks) {
  const out = []; let textLen = 0, imgCount = 0;
  for (const b of blocks) {
    if (out.length >= MAX_BLOCKS) break;
    if (b.t === "img") {
      if (imgCount >= MAX_IMGS) continue;
      if (b.v.startsWith("//")) b.v = "https:" + b.v;
      if (!/^https?:\/\//.test(b.v)) continue;
      if (/qrcode|avatar|logo|loading\.gif|\.gif\?|icon/i.test(b.v)) continue;
      imgCount++; out.push({ t: "img", v: b.v.replace(/["'\\]/g, "") });
    } else {
      const v = b.v.replace(/\s+/g, " ").trim();
      if (!v || BOILERPLATE.test(v)) continue;
      if (textLen >= MAX_TEXT) continue;
      textLen += v.length; out.push({ t: b.t, v });
    }
  }
  return textLen >= 50 || imgCount >= 3 ? out : null;
}

// 正文容器:<div class="widget-article-bd we-article-bd">;评论/页脚/相关作结束标记
const CONTAINER = /<div class="widget-article-bd we-article-bd">([\s\S]*?)(?:全部评论|<div class="[^"]*widget-comment|<div class="[^"]*widget-article-ft|<div class="[^"]*widget-article-relate|COPYRIGHT|备案号|<footer|$)/i;

const tsOfId = (id) => { const m = id.match(/0_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/); return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`) : 0; };

async function main() {
  const home = await get("https://gouhuo.qq.com/");
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const ids = [...new Set([...home.matchAll(/0_\d{14}_[A-Za-z0-9]+/g)].map((m) => m[0]))]
    .map((id) => ({ id, ts: tsOfId(id) }))
    .filter((x) => x.ts && x.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ITEMS);
  console.log(`篝火首页:近${RECENT_DAYS}天 ${ids.length} 篇待抓`);

  const items = [];
  for (const { id, ts } of ids) {
    const url = "https://gouhuo.qq.com/content/detail/" + id;
    try {
      const html = await get(url);
      const rawTitle = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
      const title = decode(rawTitle).replace(/\s*[-—|]\s*篝火(资讯|营地)[\s\S]*$/g, "").replace(/\s*[-—|]\s*篝火营地\s*$/g, "").trim();
      if (!title) { console.log("跳过(无标题):", id); continue; }
      const mm = html.match(CONTAINER);
      const content = mm ? finalizeBlocks(htmlToBlocks(mm[1])) : null;
      if (!content) { console.log("跳过(无正文):", title.slice(0, 24)); continue; }
      // 封面图:og:image 优先,否则正文首图
      let image = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1] || content.find((b) => b.t === "img")?.v || null;
      if (image && image.startsWith("//")) image = "https:" + image;
      const summary = content.filter((b) => b.t !== "img").map((b) => b.v).join(" ").slice(0, 110);
      items.push({ title, summary, source: "篝火营地", url, image, isVideo: false, ts, content });
      console.log("✓", new Date(ts + 288e5).toISOString().slice(0, 16).replace("T", " "), title.slice(0, 34));
    } catch (err) { console.error("抓取失败", id, err.message); }
  }

  if (!items.length) { console.error("未抓到任何篝火文章,保留旧缓存不覆盖"); process.exit(1); }
  // 文章内容无变化则不重写(仅 generatedAt 变动不算),避免每日空提交撑大 git 历史
  const file = new URL("./gouhuo-cache.json", import.meta.url);
  try {
    const prev = JSON.parse(readFileSync(file, "utf8"));
    if (JSON.stringify(prev.items) === JSON.stringify(items)) {
      console.log(`\n篝火内容无变化(${items.length} 篇),缓存保持不变,不提交。`);
      return;
    }
  } catch {}
  const out = { generatedAt: new Date().toISOString(), source: "篝火营地", items };
  writeFileSync(file, JSON.stringify(out), "utf8");
  console.log(`\ngouhuo-cache.json 已写入:${items.length} 篇(全文)`);
}
main();
