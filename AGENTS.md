# 给接手智能体的强制说明

本目录是“冥想一键工作流 2”。原目录 `/Users/shareit/Desktop/冥想一键工作流`
是只读基线，任何任务都不得修改、格式化、迁移或清理它。

## 启动与服务

- 主应用：`node server.mjs`，默认 `http://127.0.0.1:4319`
- Agnes：由应用包启动器管理，默认 `http://127.0.0.1:8899`
- 七平台草稿服务：主应用按需启动，默认 `http://127.0.0.1:5409`
- 固定登录浏览器：Google Chrome CDP，默认 `127.0.0.1:9222`
- Intel Python：`extensions/draft-publisher/runtime/python/bin/python3.11`

不要要求用户单独安装 Node、Python、FFmpeg 或开发依赖；Intel 迁移包已经包含。
目标电脑只要求 macOS 12+、Intel x86_64、Google Chrome 和正常网络。

## 输入与输出

工作流结束后必须生成 `work/runs/<runId>/draft-manifest.json`。草稿服务只接受
已有 `runId` 和平台列表，然后从这份清单解析真实的 MP4、MP3、4:3 封面、
16:9 封面和七个平台文案。禁止让界面直接提交任意本地文件路径。

关键接口：

- `GET /api/draft-publisher/status`
- `GET /api/draft-publisher/runs/latest`
- `GET /api/draft-publisher/runs/:runId/payload`
- `GET /api/draft-publisher/runs/:runId/assets/:kind`
- `POST /api/draft-publisher/jobs`
- `GET /api/draft-publisher/jobs/:jobId`
- `POST /api/draft-publisher/platforms/:platform/open-login`

草稿任务记录保存在 `work/draft-jobs/`，服务重启后仍可查询。

## 不可突破的安全边界

1. 抖音、快手、小红书、视频号、哔哩哔哩只能执行“保存草稿”。
2. 喜马拉雅和网易云播客只能上传并填表，必须停在最终人工确认按钮之前。
3. B站保存草稿后可重新打开、预选“健康”并保留编辑页，但不得点击正式发布。
4. 不得加入正式发布按钮、正式发布接口、定时发布、自动确认或盲目重试。
5. 不得绕过验证码、扫码、设备验证、风控或账号限制。
6. 单个平台失败只记录一次结果；不得影响其他平台，也不得自动重试。
7. 不得删除封面、Cookie、账号数据库、API 配置或用户成品。

旧 `/api/publish`、8199 正式发布器以及 `src/publisher.mjs` 已移除。不要恢复。
嵌入服务的旧 `/postVideo` 和 `/postVideoBatch` 只允许返回 HTTP 410。

## 修改后的检查顺序

1. `node --check` 检查 `server.mjs`、`src/*.mjs` 和 `public/app.js`。
2. `npm test`。
3. 用内嵌 Python执行 `py_compile`。
4. 扫描活动路径，确认没有 8199、`/api/publish` 或正式提交点击。
5. 用真实完成的 `runId` 读取 payload，核对四种素材和七套文案。
6. 先在本地弹窗检查；只有用户明确点击后才创建草稿任务。
7. 对原“冥想一键工作流”重新计算目录 SHA-256，必须仍为
   `d1905eb873587e11435a9c2eaff8776a719614a1d86e66eb269bfbfc0fcc3ab7`。

排错优先级：主服务 → 草稿服务 → Chrome 9222 → 单平台登录 → 素材路径 →
平台页面选择器。登录或风控问题要停下来交给用户处理，不能反复尝试。

