const fs = require('fs');
const path = require('path');

const base = 'G:/game-news-app';
const files = [
  path.join(base, 'news.json'),
  path.join(base, 'archive', '2026-06-11.json'),
  path.join(base, 'archive', '2026-06-10.json'),
];

const hostMap = new Map(); // hostname -> sample url

function addUrl(u) {
  if (typeof u !== 'string') return;
  u = u.trim();
  if (!u || !/^https?:\/\//i.test(u)) return;
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (!hostMap.has(host)) hostMap.set(host, u);
  } catch (e) { /* ignore */ }
}

function walkNews(news) {
  if (!Array.isArray(news)) return;
  for (const item of news) {
    if (item && typeof item === 'object') {
      if (item.image) addUrl(item.image);
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && c.t === 'img' && c.v) addUrl(c.v);
        }
      }
    }
  }
}

for (const f of files) {
  if (!fs.existsSync(f)) { console.error('MISSING', f); continue; }
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.error('PARSE FAIL', f, e.message); continue; }
  // news may be at top-level array, or data.news
  let news = Array.isArray(data) ? data : (data.news || data.items || null);
  if (!news && data && typeof data === 'object') {
    // try to find an array field
    for (const k of Object.keys(data)) {
      if (Array.isArray(data[k])) { news = data[k]; break; }
    }
  }
  walkNews(news);
}

const hosts = [...hostMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(JSON.stringify(hosts, null, 2));
console.error('TOTAL HOSTS:', hosts.length);
