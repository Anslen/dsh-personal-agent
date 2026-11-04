# 提示管理入口

仓库内的 Agent 规则、模型任务、工具说明、框架模板和技能说明集中在本目录。正文与动态参数分开：修改文本用本目录，修改参数如何取值用调用方源码。

清单按文本片段计数。工具说明、参数解释、模板的一行补充和可选扩展各占一条；这些片段由对应功能按需使用，不会全部同时放入单次请求。日常主要维护 `agent/` 下的三组规则。

| 位置                               | 管理内容                                     |
| ---------------------------------- | -------------------------------------------- |
| `agent/stickers.md`                | 主动表情检索规则                             |
| `agent/history.md`                 | 历史查询与快照时效规则                       |
| `agent/tasks.md`                   | 自主任务分派、共享表情收藏规则               |
| `catalog/agent.json`               | 插件工具说明、异步完成指令                   |
| `catalog/stickers.json`            | 联网找图、视觉复核、共享库打标提示           |
| `catalog/qq.json`                  | QQ 接入规则、工具说明及随仓库提供的扩展提示  |
| `catalog/superagent.json`          | Super-agent 工具说明、动态提示片段与通知     |
| `superagent/`                      | 主控、执行器、分派、交付等框架 Markdown 模板 |
| `skills/qq/`、`skills/superagent/` | 两个上游模块的技能说明及配套资源             |
| `profiles/chatbot.json`            | 通用聊天助手的提示配置示例                   |

## 查找与修改

使用 `rg '关键词' prompts` 查正文。`manifest.json` 列出每条集中提示的稳定 key、调用方源码及模板参数；`files.json` 将三个主要规则 key 指向 Markdown 文件。JSON 中的 key 对应源码里的 `promptText(key)` 或 `renderPrompt(key, parameters)`。

模板中的 `{{p0}}`、`{{p1}}` 等由代码传入。修改时保留这些占位符及其含义；`manifest.json` 中的参数表达式供定位调用方参考，不执行其中内容。替换只进行一遍，用户数据中的占位符不会被再次解释。新增提示时同时登记 manifest 的 key、source、parameters。

修改后运行 `pnpm test` 和 `pnpm build`。服务重启后加载新文本；Agent 规则继续通过 Super-agent 原有的版本机制保存并通知会话。框架和工具说明此次迁移保持正文不变。

## 已保存配置和角色人设

管理面板保存的 scope、delivery、overrides 等仍由各 Bot 的 Super-agent 数据库进行版本管理；这些已保存值优先于框架默认模板。`profiles/chatbot.json` 是配置示例，修改它不会覆盖已保存的自定义配置。

角色人设继续通过各 Bot 的 `personaFile` 配置引用本地文件，私有配置与历史版本不复制进公开仓库。框架模板、技能和示例的旧路径保留兼容符号链接，现有加载器和文档引用继续使用同一份文件。

上游模板和技能的授权及来源继续以根目录 `NOTICE`、`modules/qq/LICENSE`、`modules/superagent/LICENSE` 为准；移动目录不改变这些声明。
