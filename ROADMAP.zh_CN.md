# 路线图

本文档只记录延期或尚未实现的功能。已实现的内容不在本文重复记录，其设计契约见对应的 `*-design.md` 文档。

## GitLab Webhook 驱动的事件（延期）

最初的产品在持久化对话之外还有第二条执行路径：验证 GitLab Note Hook 后将其解析为幂等的**事件**，由事件运行会话并把结果发回合并请求。该路径现已完整移除，在此记录以免设计丢失。

### 计划能力

- **Note Hook 接入** — 常量时间校验 webhook 密钥、请求体大小限制、可选的用户黑名单、忽略机器人/系统备注、幂等处理投递。
- **命令解析** — 把合并请求备注中的斜杠命令（`review`、`chat`、`explain`、`fix`、`implement`）解析为带类型的事件，授权完全在应用代码中检查（包括 `fix.enabled`、`issue.implement_enabled` 等特性开关）。
- **事件生命周期** — 持久化状态机（`queued -> preparing -> analyzing -> [fixing -> verifying] -> publishing -> completed`，以及 `failed`、`stale`、`cancelled`），运行期间续租、启动时恢复中断的事件、明确的重试规则（发布失败不自动重试，因为 GitLab 侧结果不确定）。
- **版本快照安全** — 获取 diff、准备工作区和发布时都记录并复核 MR 头提交 SHA，让过期快照以 `stale` 结束而不是部分发布。
- **评审工作流** — 校验每条发现都落在新增的 diff 行上，限制上下文大小与发现数量，把发现作为 MR 备注发布，且绝不让 Agent 直接发布。
- **修复工作流** — 只产出建议，绝不提交或推送；补丁限定在改动路径内、限制大小，并通过 `git apply --check` 与 `git diff --check` 校验。
- **实现工作流** — Issue 助手，可创建 Draft MR，但绝不合并。
- **运维界面** — 运维控制台的事件列表/详情页面、事件 CLI 命令（`events list`、`events retry`）、事件指标、轨迹与执行步骤。

### 延期原因

当前阶段专注于运维控制台中由用户驱动的持久化对话。对话已经通过显式工具覆盖仓库查看、编辑、Git 操作和 GitLab 写入，因此 Webhook 路径目前是冗余的。重新引入时需要成套恢复事件存储、Webhook/命令层、各工作流及其测试。

### 恢复时的注意事项

- 授权始终留在应用代码中；绝不信任 Webhook 载荷或 Agent 输出。
- 保持窄工具集（不提供内置 shell、edit、write）以及路径/字节限制。
- 所有 Agent 输出都视为不可信；发布到 GitLab 前再次检查授权、取消状态和版本快照。
- 恢复特性时同步恢复中英文文档与集成测试。

## 长任务能力缺口：子代理 / 并行调研（计划中）

长任务适合用轻量的只读子代理并行调研，只把有界结论返回主会话，避免污染主上下文。Corvex 目前仍是一轮一个会话，尚未实现委派。设计见 [subagent-design.md](subagent-design.md)（中文），参考 Claude Code、OpenCode、Cursor、Codex CLI 与 Pi SDK 示例的上下文隔离、工具收窄、委派与结果回传方式。P0：`spawn_subagent` 工具，管理员定义 agent、全新上下文、只读工具子集、深度 1 与旁路轨迹。P1：管理界面、恢复与并发/token 预算。P2：后台完成通知与 worktree 隔离的写入型子代理。

## 计划任务：剩余的触发方式（延期）

还有两种触发方式未做：GitLab Webhook 事件触发，以及每次为任务新建独立对话（而不是在创建它的对话里执行）。见 [scheduled-tasks-design.md](scheduled-tasks-design.md)（中文）。调度器本身、cron 解析、增删改界面、时区、jitter、暂停/恢复/立即运行与对话内结构化卡片均已实现。

## 文件附件：剩余的类型（延期）

图片已实现：PNG/JPEG/GIF/WebP 按魔数识别，卡片显示缩略图，只对勾选了视觉能力的模型作为多模态内容注入；Base64 不进轨迹、不跨轮持久化。仍延期：PDF 与目录附件。见 [file-attachments-design.md](file-attachments-design.md)（中文）。
