# 线上控制台

一个部署在 Vercel 上的遥控器：**输口令 → 点按钮 → 看进度 → 下载成品**。

它**不跑流水线**。流水线跑在 GitHub Actions 上，这里只调 GitHub 的 API。

## 为什么必须是这个分工

Vercel 跑不了这条流水线，四条同时撞墙，不是配置能绕过的：

| 流水线需要 | Vercel 的上限 |
| --- | --- |
| 一次约 20 分钟 | Hobby 函数 60s（Fluid Compute 到 300s）；Pro 上限 800s ≈ 13.3 分钟 |
| `node_modules` 412MB（`ffprobe-static` 一个就 335MB） | 函数包 250MB（解压后） |
| 写 `work/runs/<runId>/` 并留给后续步骤读 | 只有 `/tmp` 可写，函数结束即消失 |
| 七平台草稿要真 Chrome + 登录态 + 扫码 | 没有，且 [AGENTS.md](../AGENTS.md) 明令不得绕过扫码风控 |

GitHub Actions 那边恰好全都有：ubuntu runner、90 分钟额度、密钥已在 Secrets、
ffmpeg 用 npm 自带的、中文字体现装、成品打包成 artifact 存 90 天。

所以：**Actions 干活，Vercel 当遥控器，发布留在你自己的机器上。**

```
浏览器 ──口令──> Vercel（毫秒级，静态页 + 5 个轻函数）
                   ├─ POST /api/run      → 触发 workflow
                   ├─ GET  /api/runs     → 运行列表（轮询）
                   ├─ GET  /api/detail   → 步骤进度 + 成品清单
                   └─ GET  /api/download → 302 到 GitHub 签名直链
                            ↓
              GitHub Actions（真正跑 20 分钟的地方）
                            ↓
              你下载成品 → 在本机走草稿流程发布
```

## 部署步骤

### 1. 建 GitHub Token

到 **GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**：

- Repository access：只勾这一个仓库
- 权限：**Actions: Read and write**、**Contents: Read-only**、**Metadata: Read-only**
- 有效期按你的习惯定，到期要换

复制那串 token，下一步用。**别提交进任何文件。**

### 2. 在 Vercel 建项目

Vercel → Add New Project → 导入这个仓库，然后：

- **Root Directory 必须设成 `web-console`**（不设的话 Vercel 会去构建仓库根目录的主应用，
  那 412MB 的依赖会直接把构建撑爆）
- Framework Preset：Other
- Build Command：留空
- Output Directory：留空

### 3. 填 5 个环境变量

Vercel 项目 → Settings → Environment Variables，五个都设成 Production + Preview：

| 名字 | 值 |
| --- | --- |
| `CONSOLE_USER` | 登录账号 |
| `CONSOLE_PASSWORD` | 登录口令 |
| `CONSOLE_SECRET` | 会话签名密钥，随机一串，**不要**和口令相同 |
| `GITHUB_TOKEN` | 第 1 步那个 token |
| `GITHUB_REPO` | `zhenghehao/mingxiang2` |

`CONSOLE_SECRET` 这样生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

账号口令的真值只放在这里和本机的 `web-console/.env.local`（已被 gitignore 挡住）。
仓库里任何文件都不该出现真值。

改完环境变量要 **Redeploy** 才生效。

### 4. 确认 Actions 的 Secrets 齐了

控制台只是遥控器，密钥仍然要在**仓库的** Secrets 里
（Settings → Secrets and variables → Actions）：

`TEXT_API_KEY`、`MINIMAX_SUBSCRIPTION_KEY`、`SENSENOVA_API_KEYS`、
`SENSENOVA_SCORER_KEYS`、`SENSENOVA_MOTION_KEYS`、`AGNES_API_KEYS`

### 5. 先体检，再生成

打开控制台，输口令，点 **「先体检密钥」**。约 30 秒，几乎不耗额度，
会把每批 key 在 runner 上的 HTTP 状态摊开。全绿了再点「生成一集」。

## 安全边界

- 账号和口令只存在环境变量里，代码和仓库里都没有真值
- 账号错还是口令错，返回的是同一句话，不告诉对方哪个对了
- 会话是 HMAC 签名的 cookie：`HttpOnly`（JS 读不到）+ `Secure`（只走 HTTPS）
  + `SameSite=Strict`（跨站不带，省掉一整类 CSRF）
- GitHub token 只留在服务端，从不下发到浏览器
- 能触发的 workflow 走白名单，日期/时段/时长逐个校验，不给拼接和注入留口子
- 页面 `noindex`，并带 CSP 和 `X-Frame-Options: DENY`

**已知限制**：登录没有失败次数限制。Serverless 没有共享状态，做限流要额外接
KV/Redis。所以口令的强度就是这道门的全部强度 —— 短口令（比如姓名+年份这种
能猜到的）在没有限流的情况下不安全，建议 20 位以上的随机串。要更严就上
Vercel 的 Deployment Protection（Pro 功能），或自己接一层 KV 计数。

## 本地调试

```bash
cd web-console && npx vercel dev
```

需要先 `vercel link`。本机的变量放 `web-console/.env.local`，`vercel dev`
会自动读，该文件已被 gitignore 挡住。
