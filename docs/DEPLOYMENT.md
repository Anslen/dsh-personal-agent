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
