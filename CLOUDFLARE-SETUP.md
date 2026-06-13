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

---

# 进阶:用 Worker 定时触发抓取(修复"15 分钟变几小时")

同一个 worker.js 还内置了一个**定时触发器**。GitHub 免费版的定时任务被严重
限流(标称每 15 分钟,实际 1-3.5 小时才跑一次),而 GitHub 的 `workflow_dispatch`
(手动/API 触发)**不限流**。让 Worker 用 Cloudflare 可靠的钟,每 15 分钟去
调用一次 dispatch 接口,就能把抓取频率修成真正的 15 分钟。

**全程免费、不用绑卡。** 需要给 Worker 一个 GitHub 令牌(只授权触发这一个工作流)。

## 步骤

### 1. 生成一个 GitHub 细粒度令牌(Fine-grained PAT)

1. 打开 <https://github.com/settings/personal-access-tokens/new>
2. **Token name** 随意,如 `dianwan-cron`;**Expiration** 选 90 天或更久
3. **Repository access** → **Only select repositories** → 勾选 `dianwan-daily`
4. **Permissions** → **Repository permissions** → 找到 **Actions**,设为 **Read and write**
5. 生成,复制那串 `github_pat_...`(只显示一次)

### 2. 把令牌存进 Worker(作为加密变量)

1. Cloudflare 控制台 → 你的 Worker(`dianwan-img`)→ **Settings** → **Variables and Secrets**
2. **Add** 一个变量:Type 选 **Secret**,Name 填 `GH_PAT`,Value 粘贴上面的令牌,保存
3. (可选)若你的仓库名/用户名不是默认,再加两个普通变量:
   `GH_REPO` = `你的用户名/dianwan-daily`(默认已是 `NicholasGA/dianwan-daily`)

### 3. 给 Worker 加 Cron 触发器

1. 同一个 Worker → **Settings** → **Triggers**(或 **Cron Triggers**)→ **Add Cron Trigger**
2. 填表达式 `*/15 * * * *`(每 15 分钟),保存
3. 确保 worker.js 已是本仓库最新版(含 `scheduled` 处理器),重新 **Deploy** 一次

## 验证

- Worker 的 **Logs**(实时日志)里,到点会看到 `dispatch update-news.yml: 204`(204 = 成功)
- 仓库 **Actions** 页面会看到 `update-news` 按 15 分钟规律地被触发(来源显示为
  workflow_dispatch,而非 schedule)
- App「我的」页底部的"更新于"时间,会稳定地每 15 分钟前进

## 说明

- 没配 `GH_PAT` 时,Worker 只跳过触发(图片/RSS 代理照常工作),不报错。
- GitHub Actions 里原有的 `schedule` 仍保留作兜底:Worker 没部署时,App 仍按
  (被限流的)老节奏更新,不会更差。两者都触发时,工作流的并发控制会自动取消
  重复运行,不会重复提交。
- Cron Trigger 在 Cloudflare 免费版可用,不产生费用。
