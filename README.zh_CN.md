# Corvex

Corvex 是面向自托管 GitLab 的代码审查与修复代理。本仓库按 [design.md](design.md) 中的路线图分阶段实现 MVP。

## 当前实现

当前实现包含：

- GitLab Note Hook 接口，并以恒定时间比较验证 Webhook Token。
- 项目和用户白名单、机器人/系统评论过滤及严格的 `@corvex` 指令解析。
- SQLite 持久化、Webhook 事件去重和审查任务入队。
- `review`、`status` 和仅任务发起者可用的 `cancel` 指令。
- GitLab MR 评论反馈、`/healthz` 与检查数据库的 `/readyz`。
- YAML 配置；密钥只通过环境变量注入。
- GitLab MR/项目元信息与分页 Diff API。
- Git 引擎：按项目维护镜像、按指定 SHA 创建隔离 detached worktree、限制 Diff 大小，并拒绝工作区外文件读取。
- OpenAI 兼容 Chat API 客户端与审查工作流：限制上下文、严格解析结构化结果、校验新增行和证据、检查严重级别并去重。

`server` 会持久化审查任务，启用 `worker` 后可异步执行。Worker 会在审查前及发布前校验 MR Diff 版本，使用隔离 worktree，并将经过校验的问题发布为行级讨论；若 GitLab 拒绝讨论位置，则回退到摘要评论。`fix` 指令仍默认禁用。

若要启用审查，设置 `agent.enabled: true`、`agent.base_url`、`agent.model`，并通过 `CORVEX_MODEL_API_KEY` 提供密钥。Webhook 处理流程只负责入队；模型调用由 Worker 执行。

## 本地运行

```sh
cp configs/config.example.yaml configs/config.yaml
```

设置 `CORVEX_GITLAB_READ_TOKEN`（只读）、`CORVEX_GITLAB_TOKEN`（允许发布 MR 评论）和 `CORVEX_WEBHOOK_SECRET`（须与 GitLab 项目 Webhook 配置一致）。读写令牌应分离，并仅授予所需权限，然后启动：

```sh
go run ./cmd/corvex --config configs/config.yaml server
```

要异步执行审查，启用 Agent 配置，并在另一个进程中启动 Worker：

```sh
go run ./cmd/corvex --config configs/config.yaml worker
```

项目 ID 和用户 ID 必须显式加入配置白名单。两者都不能为空；空白名单不会被解释为允许所有访问。

## Docker Compose

复制 `.env.example` 为 `.env`，配置读写令牌和 Webhook Secret，并准备 `configs/config.yaml`，然后运行：

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

以上命令启动 Webhook Server。若要同时运行 Worker，请在 `configs/config.yaml` 中启用 `agent.enabled: true`，然后使用 `worker` profile：

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile worker up --build -d
```

Server 和 Worker 共享 SQLite/Git 数据卷，仅 Server 暴露 8080 端口。可用以下幂等脚本注册项目 Webhook（需要 `curl` 和 `jq`）：

```sh
GITLAB_URL=https://gitlab.example.com \
GITLAB_ADMIN_TOKEN=... \
GITLAB_PROJECT_ID=101 \
CORVEX_WEBHOOK_URL=https://corvex.example.com/webhooks/gitlab \
CORVEX_WEBHOOK_SECRET=... \
./scripts/register-webhook.sh
```

管理员注册令牌只用于一次性脚本，不应提供给运行中的 Corvex 服务。

## 开发

```sh
make test
make lint
make build
```

Server 和 Worker 使用分开的 GitLab 读写令牌变量：读取操作使用只读令牌，发布评论使用写令牌。尚未实现不可信代码执行器。
