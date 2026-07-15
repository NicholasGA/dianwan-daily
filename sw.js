/* 电玩日报 Service Worker — 离线缓存(stale-while-revalidate) */

const CACHE = "dianwan-v46";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  // no-cache:防止 HTTP 缓存(Pages max-age=600)把旧文件喂进新版本缓存
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "no-cache" }))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// news.json 网络优先(刷新要拿最新数据),断网时回退缓存
// 其余资源缓存优先保证秒开,后台同时拉新版本更新缓存(下次打开生效)
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);
  if (url.pathname.endsWith("/news.json") || url.pathname.endsWith("/archive/index.json")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
