# 电玩日报 · 每日游戏新闻 App(原型)

移动端游戏新闻 App 原型。纯 HTML/CSS/JS,零依赖、无需构建,双击 `index.html` 即可在浏览器运行;把整个文件夹发到手机上用浏览器打开也能直接用。

## UI 风格

- 参考书架阅读 App 的设计语言:薰衣草紫 Hero 大字头部、书架式头条轮播(带玻璃搁板与倒影)、分类胶囊、白色圆角卡片区
- 内容排版参考游民星空 / 机核 / 二柄手机版:头条 + 分类筛选 + 资讯流 + 快讯时间轴 + 底部标签栏

## 文件结构

| 文件 | 说明 |
|---|---|
| `index.html` | 页面骨架(首页 / 快讯 / 详情 / 标签栏) |
| `styles.css` | 全部样式,设计变量集中在 `:root` |
| `data.js` | **新闻数据**(目前为演示数据) |
| `app.js` | 渲染与交互逻辑 |

## 已实现功能

- 首页:连续追新横幅、今日新闻数大字标题、头条书架轮播、分类筛选(全部/业界/主机/PC/手游)、专题 2x2 封面、资讯流
- 快讯:时间轴式业界速递,每条可点击跳转源站
- 文章详情页:配图封面 + 摘要 + **阅读原文/观看视频跳转** + 点赞/收藏/分享(本地交互)
- **真实新闻 + 刷新**:打开自动加载、点刷新按钮手动更新,新闻含配图与原文链接
- 视频 / 社区 / 我的:占位(点击有提示)

## 真实新闻数据流

```
GitHub Actions(每小时第 7 分钟,也可手动触发)
  └─ scripts/fetch-news.mjs
       收集:游民星空(列表页解析) + 机核/游研社/触乐/IGN/GameSpot(RSS)
       全文:进入每篇文章页提取正文(文字+配图的结构化块)
         游民星空 Mid2L_con / 游研社 doc-content / 触乐 the-content / 机核官方 JSON API
         IGN、GameSpot 有 Cloudflare 防护,仅摘要(详情页保留"阅读原文"按钮兜底)
  └─ 提交 news.json → GitHub Pages 自动重新发布
App 端
  └─ 启动时静默拉取 news.json;刷新按钮手动拉取(网络优先,断网回退缓存)
  └─ 中文源详情页站内读全文(段落+小标题+配图),末尾保留出处链接
  └─ 快讯点击站内打开详情,不跳出 App
  └─ data.js 仅作为离线兜底的演示数据
```

注意:GitHub 对 60 天无活动的仓库会暂停定时工作流,届时在 Actions 页面点一次
"Enable workflow" 或推一个提交即可恢复。

## 如何换数据(对接每日新闻日报)

所有内容都来自 `data.js` 的 `window.GameNewsData`,改这一个文件就能换全部内容,结构:

```js
{
  date: "YYYY-MM-DD",
  streak: { days, percent },
  featuredIds: [/* 头条轮播引用的新闻 id */],
  topicIds: [/* 专题封面引用的新闻 id */],
  news: [{ id, category, title, short, summary, source, time, comments,
           cover: { c1, c2, fg, glyph }, content: ["段落", ...] }],
  flash: [{ time, text }]
}
```

> 已配置的定时任务 `daily-aigc-gaming-digest`(每天 9 点跑的新闻日报 routine)
> 未来可以让它在生成日报的同时,按上述结构重写本目录的 `data.js`,
> App 就变成每天自动更新的真·日报客户端。

## 安装到 iPhone(PWA)

**正式地址:<https://nicholasga.github.io/dianwan-daily/>**

1. iPhone Safari 打开上面的网址
2. 点 Safari 底部**分享按钮 → 添加到主屏幕**
3. 主屏幕出现"电玩日报"图标:全屏独立运行、支持离线缓存,体验等同原生 App

更新方式:改完代码 `git push`,GitHub Pages 自动重新发布;手机端开两次 App 即可拿到新版(第一次后台拉取,第二次生效)。

### 备用:局域网直连(不依赖公网)

1. iPhone 和电脑连**同一个 Wi-Fi**
2. 电脑运行 `npx -y serve -l 5500 game-news-app`(在 G:\ 下)
3. iPhone Safari 打开 `http://192.168.3.3:5500`
4. 同样"添加到主屏幕"(此方式电脑需开机,且 HTTP 下离线缓存不生效)

## 本地预览(可选)

```
npx -y serve -l 5500 game-news-app
```

然后访问 http://localhost:5500
