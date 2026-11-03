# 上游改动边界

## Super-agent

- managementPath：每个 Bot 单独的管理接口前缀。
- extraTools：主控与执行器可挂载表情工具。
- packaged paths：单仓库构建后仍定位到原始 prompts 和 skills。
- 其余 Engine、事务、Effects 和任务生命周期保留上游实现。

## QQ

- externalDriver：消息经过原渠道过滤后交给外部驱动，失败不退入原有模型链。
- 注册实例发送器以供 Source 出站；卸载时清理。
- 源码仍保留原有能力，外部模式下会话编排归 Super-agent。

## 表情

- 配置、角色集合、路径、CLI 命令从部署环境读取。
- 原会话的任务ID与搜索结果绑定；完成事件通过原型relay而非静默notify投递。
- 公共代码没有部署者的Bot凭据、AppID或允许名单。

- QQ 聚合与最终入站入口统一切换到外部主控，补充不创建旧 Session 的回归。
- 多 Bot 浏览器面板复用原型工单界面；API 基路径按实例传递。
- 原型 Feishu 消费器修复 stdout/stderr 到达顺序导致解析错误被 ready 覆盖的问题。
- 工具执行环境使用异步上下文路由，共享宿主内不改进程级环境。

- 审核v4：多参考图与正向身份描述；脚本完成OCR、标签和对照图，模型一次简短复核决定采纳，参考图内容纳入审核指纹。
- 已保存素材支持直接重新审核，历史判断写入review_history保留。
- 配置迁移：将单张referenceImage改为2至6张referenceImages，并补充identityDescription。

- 发送时由后台取得当前会话的图片授权，模型只选择id，避免任务编号与发送凭据混淆。
- 移除表情风格的强制偏好和打分门槛。

- 统一sticker_view图片附件入口，任务执行器可直接看图；聊天工具说明修改不会触发图库复核。
