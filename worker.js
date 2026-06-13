/* ============================================================
   电玩日报 — 图片代理 Cloudflare Worker
   作用:绕过源站防盗链(不转发 Referer)+ http→https + 边缘缓存,
   作为 App 图片兜底链的首选代理(优先于公共的 wsrv.nl / Photon)。

   部署:见 CLOUDFLARE-SETUP.md(浏览器内复制粘贴,5 分钟,免费,无需命令行)
   用法:https://<你的worker>.workers.dev/?url=<图片URL>
   ============================================================ */

// 只允许代理这些新闻图床,避免变成开放代理被滥用
const ALLOW = [
  "gamersky.com",
  "3dmgame.com",
  "gcores.com",
  "yystv.cn",
  "chuapp.com",
  "17173.com",
  "17173cdn.com",
  "indienova.com",
  "ignimgs.com",
  "ign.com",
  "gamespot.com",
  "cbsistatic.com",
  "mydrivers.com",
  "wp.com",
];

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);

    // CORS 预检
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
      // 容错:允许传 协议相对(//host) 或无协议(host/path)
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
    const allowed = ALLOW.some((d) => host === d || host.endsWith("." + d));
    if (!allowed) return new Response("host not allowed", { status: 403 });

    // 边缘缓存命中直接返回
    const cache = caches.default;
    const cacheKey = new Request(reqUrl.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // 关键:不转发原站 Referer / Cookie,绕过防盗链 403
    let upstream;
    try {
      upstream = await fetch(src.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; dianwan-img/1.0)",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
    } catch (e) {
      return new Response("upstream fetch failed", { status: 502 });
    }
    if (!upstream.ok) return new Response("upstream " + upstream.status, { status: 502 });

    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "image/jpeg");
    headers.set("Cache-Control", "public, max-age=604800, immutable");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-Dianwan-Proxy", "1");

    const resp = new Response(upstream.body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
