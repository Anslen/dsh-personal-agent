# DSH Personal Agent

基于 DeepSeek Harness 的多 QQ Bot 个人助手插件。每个 Bot 有独立的 Super-agent 主控、任务与 Worker、数据库、人设和表情库；共用一个 DSH 宿主。

提示管理统一入口见 [prompts/README.md](prompts/README.md)：Agent规则、表情任务、工具说明、框架模板、技能和配置示例均集中存放，并保留旧路径兼容。

共享表情库默认位于 `stateDir/shared/stickers`，可通过顶层 `sharedStickersDirectory` 指定位置，或设 `sharedStickersEnabled: false` 关闭。`sticker_search` 默认同时搜索角色库与共享库，`library` 可指定 `personal` 或 `shared`；共享素材以 `shared:` 前缀区分，角色身份要求只作用于角色专属库。`sticker_request_search` 支持选择图库，定期检索和任务重试复用同一基建。

阅读会话历史时，Agent 可自主使用 `sticker_save` 提交消息 ID 和附件序号；后台下载、去重、实际看图、打标并决定采纳后才进入共享库。自主收藏默认静默完成，`notify: true` 才通过持久化 relay 唤醒主控交付结果。`sticker_tag` 支持看图后修正正式素材的标签。待处理与拒绝素材不向检索、发送工具开放。

获准入站的私聊或群内 @ 消息先持久化，再进入模型处理，由模型自然生成第一条回复；普通群消息仍只归档。主控与执行器都能查询历史，由 Agent 自主选择直接处理或通过 Super-agent 分派后台任务；长任务完成后主动交付。外部主控不等待旧插件的延迟聚合窗口。

QQ新消息先由主控判断归属，群会话中的旧任务订阅不会自动接管或恢复任务；明确关联由Agent自主完成。群文字回复及图片、视频说明默认@原请求发送者；回复任务内追问时可以选择对应的已交付trigger_id。主控会话代际独立持久化，切换时保留旧会话、任务和历史记录。

整体采用 GPL-3.0-or-later，上游代码保留 MIT 声明，详见 NOTICE、LICENSES 和 UPSTREAM.json。

## 组成

- `modules/superagent`：复制并保留上游 Engine、授权、Ticket/Assignment、会话、Effects、Outbox 和原始测试。新增实例管理路径及媒体工具扩展点。
- `modules/qq`：复制 QQ 插件，新增 `externalDriver` 模式，将入站交给主控，避免创建第二套模型会话。
- `modules/stickers`：保留后台联网采集、图片去重、视觉审核、标签、本地检索和实际看图校验。
- `src`：多 Bot 装配、QQ Source、渠道边界和表情任务完成事件适配。

表情搜索立即返回 started。完成或最终失败后，订阅和结果在事务内进入 Super-agent 的持久化 relay 队列，唤醒主控，再由主控决定如何通过 Outbox 回复原会话。定期补库没有人类请求订阅时不通知；被人取消的任务不因搜索结束而重新唤醒。

## 安装

要求 Node.js 24+、pnpm、官方 DSH 0.2.1-rc.5，并完成模型账号配置。原型的执行环境保留 GitHub 工作仓库与 gh CLI 配置要求。

```sh
pnpm install
pnpm build
pnpm test
pnpm test:core
dsh plugin --profile web add /absolute/path/to/dsh-personal-agent
```

安装后默认禁用，在 profile 的 `cordis.patch.yml` 中启用 `personal-agent`，参照 `examples/config.yml` 配置。凭据从各 Bot 的 `secretEnv` 指定环境变量读取，实例配置与数据应保存在仓库外或 `.local/` 中。

一个 Bot 的 `id` 和 `appId` 必须唯一。允许名单默认为空，私聊和群聊均需明确授权。`connect: false` 可用于暂停 QQ 连接并检查主控环境。侧栏“个人助手”面板提供 Bot 切换，各 Bot 沿用原型的工单、触发、授权、执行和配置页面。每个 Bot 的管理 API 在 `/personal-agent/<id>/api/`，沿用原型同源校验；也可在 DSH 插件设置中编辑 Bot 配置。

可选 `tts: { endpoint, voice, apiKeyEnv }` 连接 OpenAI 兼容语音合成服务，音色由部署配置固定。`qq_voice`、媒体发送和表情发送的目的地从原始授权消息推导。

可选 Bot 配置 `reasoningEffort: low` 固定该 Bot 主控和执行器每次模型请求的思考深度；省略时沿用宿主选择。聊天主控先自然回应或用自主拟定的确认受理后台任务，再继续查询和处理；实际发送成功的回执会释放聊天评估位置，后续消息无需等待评估超时。回应后的主控查询工具仍可用。

定时任务的依赖、挂载方式、时间规则及验证范围见[部署说明](docs/DEPLOYMENT.md)。

权限和验证边界见 [docs/VALIDATION.md](docs/VALIDATION.md)。

表情审核配置使用 `referenceImages`（2–6 张），建议提供清晰全身、正面及多视角图片。`identityDescription` 描述正向视觉特征；脚本整理OCR、标签和视觉对比信息，模型读取一张对照图，简短复核是否采纳。macOS 使用系统 Vision；其他平台需安装 `tesseract` 及 `chi_sim`、`eng` 语言数据，或配置 `STICKER_OCR_COMMAND`。参考图内容改变会使旧审核结果失效，需复核后重新使用。

## 开发与上游

新增代码中文注释；修改后执行格式化和相关测试。上游代码仅在所需接入点修改，提交时记录变更及对应测试。请勿修改 `node_modules` 作为长期维护方式。

- 上游：https://github.com/deepseek-ai/dsh-superagent-prototype
- QQ：https://github.com/wuwo1979/dsh-qqbot-muu

原型仍是研究代码。当前项目保留它的工作范式；原文设想中尚未实现的能力不因复制代码自动出现。

`qq_history` 查询当前人类消息或任务所在会话的已接收历史，支持keyword、limit和before游标；不指定其他群号。历史覆盖以实际接收和保存为准，最多最近7天、每会话2000条。
