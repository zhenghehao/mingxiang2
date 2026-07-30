# 迁移到另一台 Mac

这个包里有整套流水线的代码、素材、**以及你的全部密钥和平台登录态**。
下面按顺序做，大约 15 分钟。

> ⚠️ **这个包等同于你的账号本身。** 只能在你自己的机器之间搬，
> 不要发给别人、不要传网盘、不要放进 git 仓库。
> 要给别人的话重新打一个：`zsh packaging/build-migration.sh --no-secrets`

## 包里有什么

| 目录 | 是什么 | 放到哪 |
| --- | --- | --- |
| `冥想一键工作流/` | 主程序（Node，端口 4319） | `~/Desktop/冥想一键工作流` |
| `agnes-playground/` | 出画面的 Agnes（端口 8899） | `~/Desktop/agnes-playground` |
| `最终发布/` | 发平台的工具（Python，端口 8199） | `~/Desktop/最终发布` |
| `素材/bgm`、`素材/video` | 背景音乐和垫底视频库 | 见第 3 步 |
| `skills/` | 四个 Skill（选题、文稿、配音、发布文案） | 见第 4 步 |
| `密钥-不要外传/` | 钥匙串导出的三把钥匙 + Codex 登录态 | 见第 2 步 |

**不在包里**：`node_modules`、Python 虚拟环境、以往的成品。前两个必须在新机器上
重建 —— 里面是按 CPU 架构编译的二进制和写死的绝对路径，拷过去只会跑不起来。

## 1. 装运行环境

```bash
# Node 20 以上
node -v

cd ~/Desktop/冥想一键工作流
npm install          # 必须在新机器上跑，别拷旧的 node_modules
```

> `ffmpeg-static` 会按当前 CPU 架构下载对应的二进制。把 Intel 机器的
> `node_modules` 直接拷到 Apple Silicon（或反过来）会得到一个跑不起来的 ffmpeg，
> 报错还很难懂。所以包里没带它。

发布服务：

```bash
cd ~/Desktop/最终发布
python3 -m venv .venv311 && source .venv311/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
```

## 2. 装密钥

密钥都在包里，只有 MiniMax 和文本模型这两把需要动手装进钥匙串
（macOS 的钥匙串不能直接拷文件）。

照着 `密钥-不要外传/怎么装回去.md` 做，三条 `security add-generic-password`
命令，一分钟。商汤和 Agnes 的密钥写在源码里，跟着包走了，不用管。

装完把 `密钥-不要外传/` 删掉。

## 3. 素材库路径

主程序默认去这两个目录找 BGM 和垫底视频：

```
~/Desktop/未命名文件夹 6/未命名文件夹 2   ← 背景音乐
~/Desktop/未命名文件夹 6/未命名文件夹 4   ← 视频素材
```

把包里的 `素材/bgm` 和 `素材/video` 分别拷过去；或者在 4319 界面的
「素材库」里改成你喜欢的路径。

## 4. Skills

四个 Skill 放到主程序能读到的地方，然后在界面的 Skill 槽位里逐个绑定。
路径不固定，绑定时选到文件即可。

## 5. 各平台登录（这一步没法免掉）

平台登录态**不在这个包里**，而且没法打包 —— 发布是用 CDP 连你真实的 Chrome，
所以七个平台的会话存在 **Chrome 自己的用户资料**里，不在发布器的目录里
（`最终发布/.publisher_data/cookies/` 是空的，那里只有任务记录 `data.db`）。

两条路：

- **省事**：在新机器的 Chrome 里登录同一个 Google 账号开同步，很多站点的
  cookie 会跟过去，但国内这几个平台经常不灵。
- **稳妥**：重新扫一遍码，七个平台大约十分钟。

不管走哪条，第一次发布前都先核对一遍：Chrome 用调试端口启动

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

然后在 4319 界面「发布到各平台 → 查看发布状态」里看，显示「需要重新登录」
或「未登录」的，去那个平台的创作后台重新扫码一次。

**小红书不自动发。** 2026-07-25 它就自动化发布发过账号违规预警，所以留手动。

## 6. 跑通验证

```bash
cd ~/Desktop/冥想一键工作流 && npm start     # 4319
cd ~/Desktop/agnes-playground && node cors-proxy.js   # 8899
cd ~/Desktop/最终发布 && ./启动发布环境.command        # 8199
```

打开 http://127.0.0.1:4319 ，做一篇 3 分钟的短的先走一遍。整条跑完约 40–60 分钟，
其中 Agnes 出画面 20–40 分钟、导出视频 12 分钟左右。

## 常见问题

- **视频导出失败 / ffmpeg 报错** → `npm rebuild ffmpeg-static ffprobe-static`
- **发布全部失败，提示未登录** → Chrome 没用 9222 端口启动，或者登录态过期了
- **画面一直不出来** → Agnes 的生成跑在浏览器 iframe 里，那个页面不能关
