# 部署你自己的图片加速代理(Cloudflare Worker)

全程在浏览器里完成,**免费、不用命令行、不用绑卡**,约 5 分钟。

## 为什么要做这个

电玩日报的新闻图片来自游民星空、机核、IGN 等多个图床。其中:
- 国内源(游民/3DM/机核…)App 已能直连,正常显示;
- 国外源(IGN/GameSpot)和触乐(只有 http)需要走代理。

App 默认用公共代理 wsrv.nl,但它依赖 Cloudflare,在国内偶尔不稳。
部署一个**你自己专属的** Worker 当首选代理:不被公共服务限速、缓存归你独享。

## 步骤

1. 打开 <https://dash.cloudflare.com> ,注册 / 登录(免费账号即可)。

2. 左侧菜单点 **Workers & Pages** → **Create application** → **Create Worker**。

3. 给它起个名字,例如 `dianwan-img`,点 **Deploy**(先部署默认模板)。

4. 部署后点 **Edit code**(编辑代码),把编辑器里的内容**全部删掉**,
   粘贴本仓库 `worker.js` 的全部内容,右上角点 **Deploy**(保存并部署)。

5. 页面上会显示这个 Worker 的网址,形如:
   ```
   https://dianwan-img.<你的用户名>.workers.dev
   ```
   复制它。

6. 打开电玩日报 App → **我的** → 「图片加速服务」输入框,粘贴上面的网址,
   点**保存**。立即生效,无需重装。

## 验证是否生效

浏览器直接访问(把下面换成你的 Worker 网址):
```
https://dianwan-img.你的用户名.workers.dev/?url=https://www.gamersky.com/
```
能返回内容即部署成功。在 App 里,「我的」页保存后图片若明显更快/更稳,即说明走通了。

## 如果 workers.dev 在你的网络打不开

说明你的网络到 Cloudflare 这条路不通,这个方案帮不上忙——
App 会自动回退到 wsrv.nl → Photon → 占位字形,不会变差。
此时真正的解法是国内服务器 + 域名备案(成本较高),一般个人自用不必。

## 额度

Cloudflare 免费版 Worker 每天 10 万次请求,图片又有 7 天边缘缓存,
个人自用绰绰有余,不会产生费用。
