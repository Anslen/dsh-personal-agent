# 仓库开发约定

## Prompt 管理

- 固定提示文本统一存放在根目录 `prompts/`，包括 Agent 行为规则、后台模型任务、工具说明、模型可见参数说明及框架模板。入口和分类见 `prompts/README.md`。
- 业务代码通过 `promptText`、`renderPrompt` 或现有框架加载器读取提示，不新增散落的提示正文，也不复制出第二份默认文本。
- 常用行为规则放在 `prompts/agent/`；其他提示按模块收纳到 `prompts/catalog/`，框架模板与技能保持各自子目录。
- 新增集中提示时同步登记 `prompts/manifest.json` 的 key、调用方 source 和 parameters；独立 Markdown 规则通过 `prompts/files.json` 绑定。
- 动态数据、参数提取、权限校验和任务执行留在代码中。模板只替换占位符，不执行文本中的代码，不递归解释用户数据。
- 整理提示默认保持正文、工具可用范围及 Agent 自主决策方式不变。改变行为需要任务本身明确要求。
- 私有人设通过 `personaFile` 等部署配置引用，不把个人 Bot 设置、会话内容或凭据放进公开提示文件。
- 旧路径使用兼容链接指向统一文件；已保存在管理面板中的提示配置和历史版本继续由运行时管理，不能静默覆盖。
- 修改后执行格式化、`pnpm check:prompts`、相关测试和构建；涉及 Super-agent 模板或装配时执行 `pnpm test:core`。整理迁移时核对正文和渲染结果，避免仅移动位置就改变模型行为。
