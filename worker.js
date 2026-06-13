/* ============================================================
   电玩日报 — 通用代理 Cloudflare Worker
   作用:为 App 代理图片 + RSS/列表页文本,统一解决三类问题:
   - 绕过源站防盗链(不转发 Referer)
   - http→https(消除混合内容拦截)
   - 国外源/被墙源由 Worker 在边缘回源 + 缓存
   既是图片兜底链的首选代理,也是「即时刷新」抓取各源列表的可靠通道。

   部署:见 CLOUDFLARE-SETUP.md(浏览器内复制粘贴,5 分钟,免费,无需命令行)
   用法:https://<你的worker>.workers.dev/?url=<目标URL>
   ============================================================ */

// 只允许这些新闻相关主机,避免变成开放代理被滥用
const ALLOW = [
  // 图片图床
  "gamersky.com", "3dmgame.com", "gcores.com", "yystv.cn", "chuapp.com",
  "17173.com", "17173cdn.com", "indienova.com", "ignimgs.com", "ign.com",
  "gamespot.com", "cbsistatic.com", "mydrivers.com", "wp.com",
  // 列表/RSS 抓取
  "db2.gamersky.com", "www.gamersky.com", "www.gcores.com", "www.yystv.cn",
  "www.chuapp.com", "www.3dmgame.com", "news.17173.com",
];

const TEXT_TTL = 300;      // RSS/列表:5 分钟边缘缓存(要新鲜)
const IMG_TTL = 604800;    // 图片:7 天

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const target = reqUrl.searchParams.get("url");
    if (!target) return new Response("missing ?url", { status: 400 });

    let src;
    try {
      src = new URL(target);
    } catch {
      try {
        src = new URL("https://" + target.replace(/^\/\//, ""));
      } catch {
        return new Response("bad url", { status: 400 });
      }
    }
    if (src.protocol !== "http:" && src.protocol !== "https:") {
      return new Response("bad protocol", { status: 400 });
    }

    const host = src.hostname.toLowerCase();
    if (!ALLOW.some((d) => host === d || host.endsWith("." + d))) {
      return new Response("host not allowed", { status: 403 });
    }

    const cache = caches.default;
    const cacheKey = new Request(reqUrl.toString(), request);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // 关键:不转发原站 Referer / Cookie,绕过防盗链
    let upstream;
    try {
      upstream = await fetch(src.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; dianwan/1.0)",
          Accept: "*/*",
        },
        cf: { cacheTtl: 600, cacheEverything: true },
      });
    } catch {
      return new Response("upstream fetch failed", { status: 502 });
    }
    if (!upstream.ok) return new Response("upstream " + upstream.status, { status: 502 });

    const ct = upstream.headers.get("Content-Type") || "application/octet-stream";
    const isImg = /^image\//i.test(ct);
    const headers = new Headers();
    headers.set("Content-Type", ct);
    headers.set("Cache-Control", `public, max-age=${isImg ? IMG_TTL : TEXT_TTL}`);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-Dianwan-Proxy", "1");

    const resp = new Response(upstream.body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
