# 部署说明

## 定时任务

本项目通过外部 npm 依赖接入官方定时能力，不复制其源码。以下两个包均锁定为 `0.2.1-rc.5`，与部署使用的 DSH 版本一致，许可证为 MIT：

| 依赖                             | 提供能力                                                                 | 来源                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@deepseek-ai/dsh-schedule`      | 持久化任务、计算到期时间、重启恢复、唤醒原 Session                       | [npm](https://www.npmjs.com/package/@deepseek-ai/dsh-schedule)、[官方仓库](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/schedule/schedule)           |
| `@deepseek-ai/dsh-tool-schedule` | `schedule_create`、`schedule_list`、`schedule_update`、`schedule_delete` | [npm](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-schedule)、[官方仓库](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/schedule/tool-schedule) |

依赖通过 `package.json` 和 `pnpm-lock.yaml` 管理，安装命令：

```sh
pnpm install --frozen-lockfile
pnpm build
```

宿主必须启用定时服务。当前官方 Web 组合已经包含该服务；自行搭建宿主时，需要在具有存储域、Session 控制器及持久化服务的作用域中挂载：

```yaml
- insert:
    - id: schedule
      name: "@deepseek-ai/dsh-schedule"
```

已有服务时复用已有实例。本项目的 `cordis.patch.yml` 在主控预设中挂载工具包，主控的工具白名单放行四个管理工具。执行器通过主控安排定时任务；任务到期后由原主控判断直接处理还是创建执行任务。修改依赖或预设后重启 DSH，现有主控恢复时会重新装配工具。

支持的计划包括：一次性延迟 `after_seconds`、绝对时间 `at`、固定间隔 `every_seconds`、每日 `daily`、每周 `weekly` 和五字段 `cron`。当前锁定版本的固定间隔下限为 60 秒；本地日历规则需明确 `time_zone`，例如 `Asia/Shanghai`，绝对时间需带偏移或明确时区。

每个 Bot 使用独立主控 Session，因此工具仅管理调用 Bot 的任务。计划的 `prompt` 保留原始 `trigger_id` 和交付目标，到期事件自动唤醒原主控，再通过既有 QQ 发送工具回复原会话和请求人。周期回复按宿主实际投递轮次去重，同一轮重试不会重复发送，不同轮次可以发送相同提醒文字。

定时任务持久化由宿主存储服务管理，不放在插件源码仓库中。DSH 关闭期间不会发送；服务启动后恢复任务，周期计划只补交最近一次错过的轮次。需要准时运行时，应保持 DSH 后台服务及网络在线。macOS 可继续使用已有 LaunchAgent 和锁屏在线配置。

### 已验证范围

2026-11-05 在当前生产宿主的两个独立测试 Session 中直接调用官方工具，验证创建、查询、修改、删除、固定间隔、每日、每周及 cron 规则；跨 Session 查询不可见、删除被拒绝。一次性提醒在重启后恢复，并于到期时以 `schedule` 消息唤醒原测试会话；测试任务已清理。两个生产 Bot 的主控均已检测到四个工具。

另在两个 Bot 各自已授权的私聊验证真实提醒投递：测试任务均于北京时间12:54:47到期，大肥鱼于12:54:50.105、Bronya于12:54:50.253取得QQ发送成功回执。两条测试计划已删除，临时验证插件已移除。工具由验证脚本直接调用创建；自然语言请求到模型自主创建计划的整条路径尚未单独实测。

本次适配测试49项、框架测试1202项通过；包括周期提醒的不同轮次可发送相同文字，同一轮重试保持幂等。

## 外部绘图工具

AI Draw 可独立部署，通过官方 DSH MCP 客户端注册 `mcp__draw__generate`、`mcp__draw__search_loras`，使用 stdio 连接绘图 MCP 服务。绘图服务地址和 MCP 入口绝对路径由宿主配置管理，本仓库不复制绘图项目源码。

运行绘图项目的 `integrations/mcp/install-dsh.mjs`，在宿主安装官方 `@deepseek-ai/dsh-mcp-client` 并连接 `integrations/mcp/index.mjs` 后，为需要绘图能力的 Bot 增加配置：

```json
{
  "inheritedTools": ["mcp__draw__generate", "mcp__draw__search_loras"]
}
```

`inheritedTools` 按 Bot 开放当前作用域已注册的工具，覆盖主控、后台执行器及其受控子代理；默认空列表，重复名称会去重，未安装工具不加入工具白名单。安装外部工具或更改配置后重启宿主。

绘图引擎需要在 AI Draw 中启动。生图工具等待整批任务完成后返回图片和结果地址，适合交给后台执行器。执行器将成功图片下载到本地，调用 `qq_send_media`，传 `kind=image`、本地路径和原请求 `trigger_id`；主控在完成事件到达后交付结果。LoRA 支持本地及联网搜索，搜索本身不安装权重。

### 绘图接入验证

2026-11-05 已在两个生产 Bot 的主控作用域检测到两个 MCP 工具，并分别实际调用 LoRA 搜索，均返回 57 个已安装的 Anima LoRA。通过 MCP 实际生成一张 512×512 风景图，下载后分别通过两个 Bot 的 `qq_send_media(kind=image)` 发送到部署者已授权私聊，均返回成功；临时验证插件已移除。该验证覆盖工具调用和 QQ 图片投递。随后完成自然语言请求到自主后台绘图的整条链路复测，见下节。

通用工具配置回归、适配测试 50 项、框架测试 1203 项、Prompt 校验及构建通过。

### 长任务自主分派验证

主控使用完整系统提示（complete 模式），额外注册的普通提示段会被框架忽略。部署追加知识通过 SessionsHost.promptSuffix 合并到完整提示末尾，每次组装动态生成首回提示及通用分派知识；执行器保持自己的任务职责。此入口不隐藏工具、不拦截执行调用，分派由模型判断。

2026-11-05 北京时间21:40与21:41，通过QQ分别发送双张和单张自然语言绘图请求，消息均未要求后台。两轮均先自然回复，再调用 orchestrator_route accept 建立独立任务，主控结束回合；worker会话调用同步 MCP 生图、发送图片并提交ready报告，主控由完成事件唤醒后主动回复结果。三张图片均在QQ客户端可见。单张请求于21:41:51建任务、21:41:53由worker调用工具，21:42:01发送成功，21:42:06主控回复结果。早期四轮未分派的尝试用于迭代，最终两轮连续通过。

知识只描述通用长任务分流、同步等待成本和主控／执行器职责，不按具体工具名称强制路由。当前证据覆盖同一Bot的两次顺序请求，未单独进行并发压力验证。
