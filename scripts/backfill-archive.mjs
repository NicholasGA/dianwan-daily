/* 一次性工具:从 git 历史中的 news.json 各版本回填 archive/ 归档 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dayOf = (ts) => new Date((ts || 0) + 8 * 3600 * 1000).toISOString().slice(0, 10);

const shas = execSync("git log --format=%H -- news.json", { cwd: root })
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean)
  .reverse(); // 旧→新,新版本(可能补全了全文)覆盖旧版本

const byDay = new Map();
let versions = 0;
for (const sha of shas) {
  let j;
  try {
    j = JSON.parse(execSync(`git show ${sha}:news.json`, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString());
  } catch {
    continue;
  }
  versions++;
  for (const n of j.news || []) {
    if (!n.title || !n.ts) continue;
    const day = dayOf(n.ts);
    const m = byDay.get(day) || new Map();
    byDay.set(day, m);
    const key = n.url || n.title;
    const prev = m.get(key);
    if (!prev || (!prev.content && n.content)) {
      const { id, ...rest } = { ...prev, ...n, content: n.content || prev?.content || null };
      m.set(key, rest);
    }
  }
}

mkdirSync(new URL("../archive/", import.meta.url), { recursive: true });
const dates = [...byDay.keys()].sort().reverse();
for (const day of dates) {
  const items = [...byDay.get(day).values()].sort((a, b) => b.ts - a.ts);
  writeFileSync(new URL(`../archive/${day}.json`, import.meta.url), JSON.stringify({ date: day, items }, null, 1), "utf8");
  console.log(`${day}: ${items.length} 条`);
}
writeFileSync(new URL("../archive/index.json", import.meta.url), JSON.stringify(dates), "utf8");
console.log(`回填完成:${versions} 个历史版本 → ${dates.length} 天归档`);
