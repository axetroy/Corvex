# 路线图

本文档记录有意延期的特性。这里的项目在当前阶段尚未实现，仅作为设计记录保留，后续迭代再重新实现。

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

## 计划任务 / 自然语言调度（P0/P1 已完成，P2 规划中）

用户可以说"每周一早上 9 点检查 CI"或"45 分钟后提醒我推送分支"，到点自动作为一次普通对话轮次执行。设计见 [scheduled-tasks-design.md](scheduled-tasks-design.md)（中文），参考 Claude Code 的 `/loop` 与 `CronCreate/CronList/CronDelete`、Codex Automations 与 Cloud/Desktop 计划任务：自然语言 → 模型确认的 5 段 cron、不补跑、按用户 OAuth 令牌执行（绝不回退全局凭据）。P0（完成）：`scheduled_tasks` / `scheduled_task_runs` 表、严格 cron 解析与下次时间、Server 可中止到期循环与原子领取、一次性与循环任务经 `runTurn` 执行、启动恢复不补跑、模型侧 创建/列出/取消 工具。P1（完成）：`/api/ops/me/scheduled-tasks` 接口与运行记录、账号菜单里的运维台计划任务页、30 天过期。P2（规划）：jitter 错峰、用户时区（目前 UTC）、暂停/恢复 API、事件触发。

## 其他延期项

当前没有其他记录项。
