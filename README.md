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
- 快讯:时间轴式业界速递
- 文章详情页:封面 + 正文 + 点赞/收藏/分享(本地交互)
- 视频 / 社区 / 我的:占位(点击有提示)

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
