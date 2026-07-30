# 蚁小二安全发布运行手册

本手册记录 macOS 上使用 `yxer` CLI 3.2.4 跑通助眠视频发布时验证过的流程与故障边界。CLI 或平台 schema 更新后，以实时 `--help`、`prepare`、`schema fields` 和平台返回为准。

## 不可破坏的规则

1. 只调用 `yxer` CLI；禁止直调未公开 API、复刻后台请求或用浏览器自动化绕过验证。
2. 只有用户明确说“发布、发出去、重试发布”等才执行正式 `publish`。生成文案、校验、试运行不等于发布授权。
3. 按 `doctor → accounts list → prepare → schema fields → upload/复用资源 → validate → publish --dry-run → publish → query details` 执行。
4. 对 `validate`、试运行和正式发布使用完全相同的 payload、`publishChannel` 与 `clientId`。
5. 每个平台使用独立 payload 和独立结果文件；逐个平台提交，不把多个平台的结果混在一起。
6. 上传成功返回的同一视频和封面资源可跨平台复用，但各平台标题、正文、标签和声明字段分别生成。
7. 不手写分类、位置、话题、音乐、合集、商品或 AI 声明枚举。每次从实时 schema/query 选择；禁止复制上一次的数字值。
8. 不把 `taskSetId` 当成成功。正式提交后查询 `yxer query details <taskSetId> --json`，以任务的 `stageStatus`、`errorMessage` 和 `publishId` 为准。
9. 成功平台绝不重复提交。重试前先确认旧任务为 `fail` 且没有 `publishId`，再重新走完整预检。
10. 不向对话、日志摘要、Skill 或 `output` 写入 API Key、Cookie、Token、平台会话、客户端设备编号或其他秘密。

## 已跑通的低消耗快速路径

在同一台电脑、同一批素材、同一 yxer CLI 版本与同一本机通道中，采用以下快速路径。它减少重复探测和重复上传，但不减少发布前的安全校验。

1. 每个发布批次只运行一次 `doctor` 和 `accounts list`。CLI 版本、通道或账号状态变化时才重新运行。
2. 不为每个平台重复执行 `yxer --help`。只有命令报参数错误、CLI 版本变化或 schema 行为变化时再查看帮助。
3. 对每个平台各运行一次 `prepare` 与 `schema fields`；只在需要动态对象时补对应 query，只有骨架未知时才运行完整 `schema get`。
4. 对最终视频、竖版封面和横版封面各上传一次。保存真实资源的 `key`、`size`、`width`、`height`、`duration`、`format`，五个平台复用同一组资源，禁止因为平台不同而重复上传同一文件。
5. 视频号封面上传前先压缩到不超过 512 KB；保留原图供其他平台使用。竖版建议 720×1280，横版建议 1280×720，并以实时 schema 为准。
6. 每个平台从 `publish init` 或实时 schema 骨架生成独立 payload。之后锁定 payload；`validate`、`publish --dry-run`、正式 `publish` 三步不得临时换字段、资源或通道。
7. 逐个平台正式提交一次，立刻保存 `taskSetId` 并查询详情。只有 `stageStatus: success` 才记为成功。
8. 成功平台立即加入“禁止重发”集合。失败平台按登录、额度、风控或 CLI 校验问题单独处理，不重新跑整批。

同一内容再次执行时，先读取当天 `清单/蚁小二发布/发布结果.json`：已有 `success` 和 `publishId` 的平台直接跳过；只有明确失败或未创建任务的平台才进入下一次预检。

## 发布前检查

### 1. 锁定本次文件

- 使用当天 `output/<日期>/<主题>/` 中的最终视频、竖版封面和平台文案。
- 优先使用已经把封面放入首帧的最终视频；同时保留独立封面图供平台上传。
- 核对视频时长、尺寸、文件大小与上传后资源元数据一致。
- 同一内容可以共用视频和封面，但必须保留平台原生标题和正文，不机械复制。

### 2. 检查环境和账号

依次执行：

```bash
yxer doctor --json
yxer accounts list --json
yxer prepare <平台> video --json
yxer schema fields <平台> video --json
```

- 只选择状态有效、平台名称匹配且用户确认的账号。
- 不因昵称相似而猜账号；保存本次选择的账号 ID，但不要展示秘密字段。
- `prepare` 或实时 schema 与历史文档冲突时，以当前 CLI 输出为准。

### 3. 确认媒体资源

- 只复用 `yxer upload` 的真实 `key`、`size`、`width`、`height`、`duration` 和 `format`。
- 不把本地路径或普通公网 URL 伪装成已上传资源。
- macOS 上若 yxer 3.2.4 因错误调用 PowerShell 而无法定位 `ffprobe`，只使用项目中已经验证的兼容帮助器，让它返回真实 `ffprobe` 路径后重新执行 `yxer upload`；不要伪造媒体探测结果，不要绕过 CLI 上传。
- 本机已验证的兼容帮助器目录是 `/Users/shareit/Documents/Codex/2026-07-16/wo-xia/tools`。仅在 yxer 3.2.4 确实报 `failed to locate ffprobe` 且该目录中的帮助器仍存在、可执行时，把该目录临时放到本次 `yxer upload` 的 `PATH` 前端；不要修改全局 shell 配置。
- CLI 升级后先按正常上传重试；不要永久假设该兼容问题仍存在。

## 选择云发布或本机发布

### 云发布

云发布前查询账号代理与团队代理。`publish --dry-run` 的 `remoteChecks: false` 只证明本地结构有效，不能证明正式云发布一定有代理。

- 正式云发布返回“未设置代理/账号代理不存在”时立即停止。
- 不要把同一 payload 连续重试到云端。
- 配置地区代理可能涉及出口地区、费用和账号安全；必须让用户选择地区或明确授权，不能自行绑定。
- 用户不希望使用云代理，或云发布因代理失败且用户接受本机发布时，切换本机通道并重新执行 validate 和 dry-run。

### 本机发布

本机发布必须满足：蚁小二桌面客户端已启动、用户已登录、设备已注册在线、CLI 已保存本机客户端 ID。

- 先打开客户端并确认日志出现“设备注册成功”。
- CLI 的 `localPublishClientId` 为空时，从客户端自己的安全配置中读取 `deviceId`，使用 `yxer config set-local-client-id <clientId>` 写入 CLI；禁止把编号输出给用户。
- 三步都显式使用 `--publish-channel local --client-id <clientId>`。
- 客户端在线不代表各平台登录都有效；仍需分别查询正式任务结果。

## 正式发布顺序

对每个平台单独执行并保存结果：

```bash
yxer validate <平台> video <payload.json> --publish-channel <cloud|local> [--client-id <id>] --json
yxer publish video <平台> <payload.json> --publish-channel <cloud|local> [--client-id <id>] --dry-run --json
yxer publish video <平台> <payload.json> --publish-channel <cloud|local> [--client-id <id>] --json
yxer query details <taskSetId> --json
```

提交策略：

1. 先核对 validate 与 dry-run 均为 `ok: true`。
2. 再确认正式发布授权仍然有效。
3. 每次只提交一个平台。
4. 保存 CLI 原始 JSON，但不保存含秘密的桌面客户端原始日志。
5. 查询任务详情；只有 `stageStatus: success` 才向用户报告“发布成功”。
6. `publishing` 只能报告“处理中”，继续查询；`fail` 则报告失败原因并停止该平台。

## 已验证的故障处理

| 现象 | 含义 | 必须采取的动作 | 禁止事项 |
|---|---|---|---|
| 云发布正式提交提示“未设置代理” | dry-run 未做远程代理检查 | 查询代理；让用户选择配置代理或接受本机发布；切换后重跑 validate/dry-run | 不盲目重试云发布；不自行选代理地区 |
| 本机发布提示客户端不在线或缺少 clientId | 桌面客户端未连接 CLI | 启动客户端、确认设备注册、设置本机 clientId，再重跑预检 | 不编造 clientId；不把 deviceId 显示出来 |
| 账号列表显示有效，但任务详情提示“获取用户信息失败登录失效” | 账号记录存在，但目标平台会话已过期 | 停止该平台；让用户在蚁小二重新登录目标平台；确认旧任务无 `publishId` 后再单独预检和发布 | 不相信账号列表状态而连续重发；不牵连已成功平台 |
| 抖音提示账号存在风险，要求创作者中心验证 | 平台风控，不是文案或视频错误 | 让用户在抖音创作者中心手动发布一次并完成验证；完成后再全量预检 | 不自动绕过验证码；不连续重发 |
| 快手提示“获取视频上传参数失败” | 常见于快手登录/授权状态过期 | 让用户在蚁小二客户端重新登录或更新快手授权；确认旧任务无 `publishId` 后重跑全流程 | 不因 dry-run 通过就宣称已修复；不直接复投旧任务 |
| 正式提交提示“今日发布次数已达上限”（如错误码 1001） | 蚁小二额度阻止任务创建 | 查询记录确认没有新任务；等待额度恢复或由用户调整套餐后再发 | 不同一时段反复提交；不尝试绕过额度 |
| CLI 返回 taskSetId | 蚁小二已受理 | 继续 `query details` 直到成功或失败 | 不立刻称为“平台发布成功” |
| 多平台中只有部分成功 | 平台状态彼此独立 | 记录成功平台，只修复并重试失败平台 | 不重新批量提交全部平台 |
| B站分类经过 query 后仍被 yxer 3.2.4 校验器拒绝 | 可能是 CLI 版本的分类对象校验不一致 | 保留实时 query/schema 证据，升级或报告 CLI 问题后重试 | 不手写虚构分类对象；不绕过 CLI/API 强发 |

## 日志安全

- 优先读取 `yxer` 的结构化 JSON 与 `query details`，不要直接输出蚁小二客户端完整日志。
- 必须查客户端日志时，只提取目标时间附近的错误摘要，并在显示前过滤 `cookie`、`token`、`authorization`、`password`、`secret`、`key`、证书、私钥和会话字段。
- 不要把含 Cookie、CSRF、登录态或安全 SDK 数据的日志复制到聊天、提交记录或 `output`。
- 若命令失败时 JSON 写到 stderr，使用安全的捕获方式保存经过筛选的错误摘要；不要为了留档重复执行正式发布。

## 当天发布审计

在 `output/<日期>/<主题>/清单/蚁小二发布/` 保存：

- 每个平台 payload。
- validate、dry-run、正式 publish 和 details 的 JSON。
- 一份不含秘密的 Markdown 汇总：账号显示名、平台标题、通道、任务编号、最终状态、失败原因、是否存在 `publishId`、下一步。

汇总中明确标记：

- “发布成功”：`stageStatus: success`。
- “处理中”：已受理但尚无最终状态。
- “发布失败”：`stageStatus: fail` 或正式提交被服务器拒绝。
- “未创建任务”：额度、代理等错误发生在任务创建前。

资源审计只保存蚁小二上传返回的媒体元数据，不保存本机 clientId。相同文件再次发布前，优先复用审计中的资源 key；只有文件发生变化、资源失效或 CLI 明确要求重新上传时才上传新资源。

## 结束条件

只有满足以下任一条件才结束：

- 所有用户指定的平台都已 `success`；或
- 部分成功，剩余平台遇到必须由用户完成的验证、登录、代理选择或额度恢复，并已清楚记录且没有重复发布风险。
