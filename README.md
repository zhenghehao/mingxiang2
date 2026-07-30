# 冥想一键工作流 2

本地一体化冥想内容工作台：

`选题 → 文稿 → TTS → 人声 → 混音 → Agnes 画面 → 视频 → 双封面 → 七平台草稿交接`

启动：

```bash
npm start
```

打开 `http://127.0.0.1:4318`。七平台草稿服务由主应用自动启动，不需要单独运行。

工作流完成后会自动打开草稿窗口，但必须由用户手动点击一次才开始处理：

- 抖音、快手、小红书、视频号、哔哩哔哩：只保存草稿。
- 喜马拉雅、网易云播客：上传并填表，停在人工确认前。
- B站：双封面、简介、标签、AI声明、健康分类；保存后重新打开并预选健康。

旧 8199 正式发布流程已移除。系统没有自动正式发布入口，不绕过验证码或风控，
也不会对失败平台盲目重试。

开发和接手前必须先阅读 [AGENTS.md](AGENTS.md) 与
[七平台草稿系统交接](docs/七平台草稿系统交接.md)。

## 两种跑法

**本机跑**：`npm start`，功能完整，包含七平台草稿。见下面「新克隆之后要补两样」。

**线上跑**：流水线在 GitHub Actions 上（[.github/workflows/generate.yml](.github/workflows/generate.yml)），
用 [web-console](web-console/README.md) 这个带口令的 Vercel 控制台触发和下载成品。
线上**没有**七平台草稿——那需要真实浏览器登录态和扫码，只能在你自己的机器上做。

改过 Secrets 或换过端点后，先跑
[体检 workflow](.github/workflows/preflight.yml)（约 30 秒，几乎不耗额度）
确认密钥在 runner 上能用，再跑 20 分钟的正式生成。

> Agnes 的端点**按环境分**：本机在国内走 `apihub.agnes-ai.cn`，
> GitHub runner 在海外必须走 `apihub.agnes-ai.com`。两者是同一个网关的地区镜像，
> 同样 OpenAI 兼容、同一批令牌、同一套模型名，只差域名。用错的那个表现是一直
> 401，很容易误判成「key 不对」。

## 新克隆之后要补两样

仓库里**没有**密钥，也**没有**内嵌 Python 运行时，两者都被 `.gitignore` 挡住了。
纯 `git clone` 之后主应用能起来，但选题、封面和七平台草稿都会报错。

### 1. 密钥

密钥有三个来源，优先级从高到低：环境变量 → macOS 钥匙串 → `data/config.json`。

**GitHub 仓库 Settings → Secrets 里的密钥不算。** 那批只在 GitHub Actions 的
runner 里作为环境变量注入（见 [.github/workflows/generate.yml](.github/workflows/generate.yml)），
`git clone` 永远不会把它们带到本机 —— 这是 GitHub 的设计，不是配置错了。
本机跑必须在本机再配一次：

```bash
node scripts/check-secrets.mjs
```

这条只打印每把 key 的长度和首尾各 4 位，再对各家端点发一次最小请求，
把 HTTP 状态摊开。`✗ 没设` 的就是缺的。补法是在 `~/.zshrc` 里
`export KEY="值"`（清单见 [.env.example](.env.example)），开新终端生效。

文本引擎和 MiniMax 也可以存 macOS 钥匙串，界面「API 设置」里存即可，
服务名 `com.shareit.sleepflow-studio`。

### 2. 内嵌 Python 运行时

`extensions/draft-publisher/runtime/` 有 4900+ 个文件，不进仓库。缺了它
`/api/draft-publisher/status` 会返回「找不到内嵌 Intel Python 运行环境」，
七个平台全是 `login: missing`：

```bash
cd extensions/draft-publisher/app && uv sync --extra web
```

主要端口：

| 端口 | 服务 |
| --- | --- |
| 4318 | 主应用 |
| 5409 | 内嵌七平台草稿服务 |
| 8899 | Agnes |
| 9222 | 固定 Google Chrome 登录状态 |

测试：

```bash
npm test
extensions/draft-publisher/runtime/python/bin/python3.11 -m py_compile \
  extensions/draft-publisher/app/sau_backend.py
```

Intel 迁移包：

```bash
zsh packaging/build-intel-migration.sh
zsh packaging/verify-intel-migration.sh
```

最终只交付桌面的 `冥想一键工作流2-Intel-完整迁移包-含API.zip`。

