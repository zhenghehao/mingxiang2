# 冥想一键工作流 2

本地一体化冥想内容工作台：

`选题 → 文稿 → TTS → 人声 → 混音 → Agnes 画面 → 视频 → 双封面 → 七平台草稿交接`

启动：

```bash
npm start
```

打开 `http://127.0.0.1:4319`。七平台草稿服务由主应用自动启动，不需要单独运行。

工作流完成后会自动打开草稿窗口，但必须由用户手动点击一次才开始处理：

- 抖音、快手、小红书、视频号、哔哩哔哩：只保存草稿。
- 喜马拉雅、网易云播客：上传并填表，停在人工确认前。
- B站：双封面、简介、标签、AI声明、健康分类；保存后重新打开并预选健康。

旧 8199 正式发布流程已移除。系统没有自动正式发布入口，不绕过验证码或风控，
也不会对失败平台盲目重试。

开发和接手前必须先阅读 [AGENTS.md](AGENTS.md) 与
[七平台草稿系统交接](docs/七平台草稿系统交接.md)。

主要端口：

| 端口 | 服务 |
| --- | --- |
| 4319 | 主应用 |
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

