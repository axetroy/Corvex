# Corvex

Corvex 是面向自托管 GitLab 的代码审查与修复代理。本仓库按 [design.md](design.md) 中的路线图分阶段实现 MVP。

## 当前实现

当前实现包含：

- GitLab Note Hook 接口，并以恒定时间比较验证 Webhook Token。
- 项目和用户白名单、机器人/系统评论过滤及严格的 `@corvex` 指令解析。
- SQLite 持久化、Webhook 事件去重、审查/Fix 任务队列及 Fix 授权审计。
- `review`、读取指定 MR 文件的 `explain <path>`、白名单授权的 `fix`、`status` 和仅任务发起者可用的 `cancel` 指令。
- GitLab MR 评论反馈、`/healthz`、检查数据库的 `/readyz`，以及只暴露任务状态计数的 Prometheus `/metrics`。
- YAML 配置；密钥只通过环境变量注入。
- GitLab MR/项目元信息与分页 Diff API。
- Git 引擎：按项目维护镜像、按指定 SHA 创建隔离 detached worktree、限制 Diff 大小，并拒绝工作区外文件读取。
- OpenAI 兼容 Chat API 客户端与审查工作流：限制上下文、严格解析结构化结果、校验新增行和证据、检查严重级别并去重。

`server` 会持久化审查任务，启用 `worker` 后可异步执行。Worker 会在审查前及发布前校验 MR Diff 版本，使用隔离 worktree，并将经过校验的问题发布为行级讨论；若 GitLab 拒绝讨论位置，则回退到摘要评论。Fix 提案默认关闭并使用独立用户白名单。启用后，Worker 会让模型生成受限 unified diff，仅在隔离 worktree 和 MR 已变更文件范围内应用，并运行内置的 `git apply --check` 与 `git diff --check`，最后将补丁发到 MR 供人工应用。不会运行仓库脚本、创建提交或推送代码。

Worker 使用 30 秒任务租约并定期续租；进程中断后，未进入发布阶段的任务最多执行 3 次。发布阶段租约过期时，因评论结果可能不确定，任务会失败而不会自动重试，以避免重复评论。

若要启用审查，设置 `agent.enabled: true`、`agent.base_url`、`agent.model`，并通过 `CORVEX_MODEL_API_KEY` 提供密钥。`agent.max_output_tokens` 限制每次模型响应的最大输出 token 数（默认 4096，最大 8192）；可设置 `agent.daily_token_budget` 限制每日 token 预算（UTC，`0` 表示不启用）。预算按输入字节数加最大输出 token 数保守预留，收到模型用量后按实际 token 结算；请求结果不确定时会保留预留量。它是 token 预算，不是按模型价格计算的费用上限。Webhook 处理流程只负责入队；模型调用由 Worker 执行。若要启用 Fix 提案，还需设置 `fix.enabled: true`，并在 `fix.allowed_user_ids` 中配置允许的 GitLab 用户 ID；该白名单不能为空，且必须启用 Agent。

## 本地运行

```sh
cp configs/config.example.yaml configs/config.yaml
```

设置 `CORVEX_GITLAB_READ_TOKEN`（只读）、`CORVEX_GITLAB_TOKEN`（允许发布 MR 评论）和 `CORVEX_WEBHOOK_SECRET`（须与 GitLab 项目 Webhook 配置一致）。读写令牌应分离，并仅授予所需权限，然后启动：

```sh
go run ./cmd/corvex --config configs/config.yaml server
```

要异步执行审查或 Fix 提案，启用 Agent 配置，并在另一个进程中启动 Worker：

```sh
go run ./cmd/corvex --config configs/config.yaml worker
```

项目 ID 和用户 ID 必须显式加入配置白名单。两者都不能为空；空白名单不会被解释为允许所有访问。

SQLite 在线备份可以在服务运行期间创建，目标文件必须不存在：

```sh
go run ./cmd/corvex backup \
  --database ./data/state/corvex.db \
  --output ./data/backups/corvex-$(date +%Y%m%d%H%M%S).db
```

恢复时先停止 Server 和 Worker，再将已验证的备份文件替换为配置中的数据库文件并重新启动服务。备份与恢复操作应遵循组织自身的加密、访问控制和异地保存策略。

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

## CI 与发布

GitHub Actions 会在 Linux、macOS 和 Windows 上运行测试及 `go vet`，并构建 Linux、macOS、Windows 的 amd64 和 arm64 二进制文件。向 `main` 推送、创建 Pull Request 或推送版本标签都会触发 CI。

推送版本标签（例如 `v1.0.0`）即可发布 GitHub Release。GoReleaser 会附上六种平台/架构组合的压缩二进制包以及 SHA-256 校验和文件。
