/* ============================================================
   电玩日报 — 通用代理 + 定时触发 Cloudflare Worker

   两个职责:
   1) fetch:代理图片 + RSS/列表页文本(绕防盗链 / http→https / 边缘缓存),
      既是图片兜底链首选代理,也是「即时刷新」抓各源列表的可靠通道。
   2) scheduled(Cron Trigger):用 Cloudflare 可靠的钟,定时调用 GitHub
      workflow_dispatch 接口触发抓取流水线 —— workflow_dispatch 不受 GitHub
      schedule 的限流影响,从而把"标称 15 分钟实际 1-3.5 小时"修成真 15 分钟。

   部署 + 配置 Cron 与密钥:见 CLOUDFLARE-SETUP.md
   ============================================================ */

// 触发的 GitHub 仓库与工作流(可用 Worker 环境变量 GH_REPO / GH_WORKFLOW 覆盖)
const DEFAULT_REPO = "NicholasGA/dianwan-daily";
const DEFAULT_WORKFLOW = "update-news.yml";

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

  // Cron Trigger:到点用可靠的 Cloudflare 钟触发 GitHub 抓取流水线
  async scheduled(event, env, ctx) {
    if (!env.GH_PAT) {
      console.log("未配置 GH_PAT,跳过触发(仅图片/RSS 代理仍可用)");
      return;
    }
    const repo = env.GH_REPO || DEFAULT_REPO;
    const workflow = env.GH_WORKFLOW || DEFAULT_WORKFLOW;
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
    ctx.waitUntil(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_PAT}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "dianwan-cron-worker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      })
        .then(async (r) => {
          // 成功返回 204 No Content
          console.log(`dispatch ${workflow}: ${r.status}${r.ok ? "" : " " + (await r.text()).slice(0, 160)}`);
        })
        .catch((e) => console.error("dispatch failed: " + e.message))
    );
  },
};
