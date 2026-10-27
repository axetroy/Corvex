# 快速开始

Corvex 是面向自托管 GitLab 的代码审查与修复代理。Webhook Server 接收 GitLab Note Hook 事件，可选 Worker 异步处理排队的审查与修复任务。

## 环境要求

- [`go.mod`](https://github.com/axetroy/Corvex/blob/main/go.mod) 指定的 Go 版本
- GitLab 项目及其 Webhook
- 用于读取仓库的 GitLab API 令牌，以及（发布审查评论时）具有写权限的令牌

## 本地运行

复制示例配置，并通过环境变量设置必要密钥：

```sh
cp configs/config.example.yaml configs/config.yaml
```

设置 `CORVEX_GITLAB_READ_TOKEN` 为只读令牌，`CORVEX_GITLAB_TOKEN` 为允许发布合并请求评论的令牌，并将 `CORVEX_WEBHOOK_SECRET` 设置为 GitLab Webhook 中配置的密钥。读写令牌应分开，并仅授予所需权限。

启动 Webhook Server：

```sh
go run ./cmd/corvex --config configs/config.yaml server
```

在配置中明确添加获准使用 Corvex 的项目 ID 和用户 ID。两个白名单都不能为空；空白名单不会授予无限制访问权限。

## 启用审查

配置 `agent.enabled: true`、`agent.base_url` 和 `agent.model`，然后提供 `CORVEX_MODEL_API_KEY`。在另一个进程中启动 Worker：

```sh
go run ./cmd/corvex --config configs/config.yaml worker
```

Webhook 处理流程只负责入队；模型调用由 Worker 执行。Worker 会在审查前和发布前确认合并请求 Diff 未发生变化。审查在隔离 worktree 中进行，经过验证的问题会以行级讨论形式发布；如果失败，则回退为摘要评论。

可通过 `agent.daily_token_budget` 设置 UTC 每日 Token 预算。它是 Token 预算，并非基于模型价格的费用上限。所有可用配置项请参阅 [`configs/config.example.yaml`](https://github.com/axetroy/Corvex/blob/main/configs/config.example.yaml)。

## 修复提案

修复提案默认关闭。启用时，将 `fix.enabled` 设为 `true`，并配置非空的 `fix.allowed_user_ids` 白名单；同时必须启用 Agent。提案补丁仅限于合并请求已变更的文件，经过校验后发布，供人工应用。Corvex 不会运行仓库脚本、创建提交或推送代码。

## Docker Compose

将 `.env.example` 复制为 `.env`，配置 GitLab 令牌和 Webhook 密钥，并准备 `configs/config.yaml`。启动 Server：

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

如需同时运行 Worker，请在配置中启用 Agent，并使用 `worker` profile：

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile worker up --build -d
```

## 开发

```sh
make test
make lint
make build
```

备份与恢复、数据保留、监控指标等运维细节请参阅[仓库 README](https://github.com/axetroy/Corvex/blob/main/README.zh_CN.md)。
