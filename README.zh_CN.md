# Corvex

Corvex 是基于单一 TypeScript 应用和 Pi SDK 构建的自托管 GitLab 代码审查与修复代理。架构说明请参阅 [design.md](design.md)，使用文档请参阅[文档站点](https://axetroy.github.io/Corvex/)。

## 当前实现

当前实现包含：

- GitLab Note Hook 接口，并以恒定时间比较验证 Webhook Token。
- 项目和用户白名单、机器人/系统评论过滤及严格的 `@corvex` 指令解析。
- SQLite 持久化、Webhook 事件去重、审查/Fix 任务队列及 Fix 授权审计。
- `review`、读取指定 MR 文件的 `explain <path>`、白名单授权的 `fix`、`status` 和仅任务发起者可用的 `cancel` 指令；任务进入发布阶段前可请求取消。
- GitLab MR 评论反馈、`/healthz`、检查数据库的 `/readyz`，以及包含任务状态、模型调用成功/失败数、耗时和 Token 汇总的 Prometheus `/metrics`。
- 可选的 Basic Auth 保护只读运维控制台，提供队列概览、Worker 心跳、可筛选任务列表和尝试详情；未配置运维凭据时默认关闭。
- YAML 配置；密钥只通过环境变量注入。
- GitLab MR/项目元信息与分页 Diff API。
- Git 引擎：按项目维护镜像、按指定 SHA 创建隔离 detached worktree、限制 Diff 大小，并拒绝工作区外文件读取。
- 基于 Pi SDK Agent Session 和 OpenAI 兼容 Provider 的审查工作流：提供限制在固定 SHA worktree/可信 Skill 路径内、单文件最多 64 KiB 的只读工具；限制上下文、严格解析结构化结果、校验新增行和证据、检查严重级别并去重。
- 配置初始化/校验、任务列表与安全的发布前重试、默认 dry-run 的 Git 存储清理，以及输出 precision/recall/F1 的在线审查基准。

`server` 会持久化审查任务，启用 `worker` 后可异步执行。Worker 会在审查前及发布前校验 MR Diff 版本，使用隔离 worktree，并将经过校验的问题发布为行级讨论；若 GitLab 拒绝讨论位置，则回退到摘要评论。Fix 提案默认关闭并使用独立用户白名单。启用后，Worker 会让模型生成受限 unified diff，仅在隔离 worktree 和 MR 已变更文件范围内应用，并运行内置的 `git apply --check` 与 `git diff --check`，最后将补丁发到 MR 供人工应用。不会运行仓库脚本、创建提交或推送代码。SQLite 会记录审查/解释/Fix 请求、授权与取消结果及任务状态迁移。基准使用人工标注的合成样例；显式运行时会调用模型 API 并产生费用。

Worker 使用 30 秒任务租约并定期续租；进程中断后，未进入发布阶段的任务最多执行 3 次。发布阶段租约过期时，因评论结果可能不确定，任务会失败而不会自动重试，以避免重复评论。

若要启用审查，设置 `agent.enabled: true`、`agent.base_url`、`agent.model`，并通过 `CORVEX_MODEL_API_KEY` 提供密钥。模型请求由 Pi SDK Session 执行，并受 `agent.request_timeout` 限制。`agent.max_output_tokens` 限制每次模型响应的最大输出 token 数（默认 4096，最大 8192）；可设置 `agent.daily_token_budget` 限制每日 token 预算（UTC，`0` 表示不启用）。预算按输入字节数加最大输出 token 数保守预留，收到模型用量后按实际 token 结算；请求结果不确定时会保留预留量。它是 token 预算，不是按模型价格计算的费用上限。`agent.skill_paths` 指定可信 Pi Skill 目录。MCP 默认关闭；启用 `agent.mcp_enabled` 后，会从服务的 Pi Agent 目录加载 MCP 配置。MCP 服务以 Worker 的操作系统权限运行，并非沙箱。Webhook 处理流程只负责入队；模型调用由 Worker 执行。若要启用 Fix 提案，还需设置 `fix.enabled: true`，并在 `fix.allowed_user_ids` 中配置允许的 GitLab 用户 ID；该白名单不能为空，且必须启用 Agent。

## 本地运行

需要 Node.js 26.12.1 及 npm。SQLite 使用 Node.js 内置的 `node:sqlite` 模块。

```sh
npm ci
npm run build
npm start -- init
```

编辑 `configs/config.yaml`，填写 GitLab URL 和项目/用户白名单。设置 `CORVEX_GITLAB_TOKEN`（允许发布 MR 评论）和 `CORVEX_WEBHOOK_SECRET`（须与 GitLab 项目 Webhook 配置一致），验证配置后启动 Server：

```sh
npm start -- --config configs/config.yaml check-config
npm start -- --config configs/config.yaml server
```

如需启用可选运维控制台，请同时设置 `CORVEX_OPS_USERNAME` 和 `CORVEX_OPS_PASSWORD`，然后通过 `/ops` 访问。请使用强且唯一的密码，并通过 HTTPS 访问。

Server 只需写令牌和 Webhook Secret。要异步执行审查或 Fix 提案，启用 Agent 配置，并额外设置 `CORVEX_GITLAB_READ_TOKEN`（只读）和 `CORVEX_MODEL_API_KEY`，然后在另一个进程中启动 Worker：

```sh
npm start -- --config configs/config.yaml --for worker check-config
npm start -- --config configs/config.yaml worker
```

项目 ID 和用户 ID 必须显式加入配置白名单。两者都不能为空；空白名单不会被解释为允许所有访问。

SQLite 在线备份可以在服务运行期间创建，目标文件必须不存在：

```sh
npm start -- backup \
  --database ./data/state/corvex.db \
  --output ./data/backups/corvex-$(date +%Y%m%d%H%M%S).db
```

恢复时先停止 Server 和 Worker，再将已验证的备份文件替换为配置中的数据库文件并重新启动服务。备份与恢复操作应遵循组织自身的加密、访问控制和异地保存策略。

Server 每天会清理超过 `storage.retention_days`（默认 90 天）的终态任务、任务尝试、Webhook 事件和每日 Token 用量，并清理超过 `storage.audit_retention_days`（默认 365 天）的审计记录。仅终态任务会被删除；排队或运行中的任务会保留。请按组织的审计/保留要求调整期限。使用 `npm start -- storage cleanup --config configs/config.yaml` 可预览未使用 Git 存储清理；实际清理前需安排维护窗口并停止 Worker。

## Docker Compose

复制 `.env.example` 为 `.env`，配置写令牌和 Webhook Secret，并准备 `configs/config.yaml`，然后运行：

```sh
docker compose --env-file .env -f deploy/compose.yaml pull corvex
docker compose --env-file .env -f deploy/compose.yaml up -d
```

以上命令使用预构建的 `ghcr.io/axetroy/corvex` 镜像并启动 Webhook Server。若要同时运行 Worker，请在 `configs/config.yaml` 中启用 `agent.enabled: true`，在 `.env` 中提供读令牌和模型密钥，然后使用 `worker` profile：

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile worker pull
docker compose --env-file .env -f deploy/compose.yaml --profile worker up -d
```

从本地源码构建时，可在 `docker compose up` 命令中使用 `--build`。Server 和 Worker 共享 SQLite/Git 数据卷，仅 Server 暴露 8080 端口。可用以下幂等脚本注册项目 Webhook（需要 `curl` 和 `jq`）：

```sh
GITLAB_URL=https://gitlab.example.com \
GITLAB_ADMIN_TOKEN=... \
GITLAB_PROJECT_ID=101 \
CORVEX_WEBHOOK_URL=https://corvex.example.com/webhooks/gitlab \
CORVEX_WEBHOOK_SECRET=... \
./scripts/register-webhook.sh
```

管理员注册令牌只用于一次性脚本，不应提供给运行中的 Corvex 服务。

Compose 默认限制 Server 为 1 CPU/1 GiB、Worker 为 2 CPU/2 GiB，PID 上限均为 256；JSON 文件日志单个最大 10 MiB、保留 3 个文件。可通过 `CORVEX_MEM_LIMIT`、`CORVEX_CPUS`、`CORVEX_PIDS_LIMIT` 及对应的 `CORVEX_WORKER_*` 变量调整容器限制。

## 开发

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

显式运行带标注的审查基准（会调用配置的模型三次）：

```sh
npm run benchmark:review -- --config configs/config.yaml --min-f1 0.6
```

Worker 使用 GitLab 只读令牌读取 API/仓库，并使用写令牌发布评论；Server 只需写令牌。尚未实现不可信代码执行器。

## CI 与发布

GitHub Actions 使用 Node.js 26.12.1 运行 lint、类型检查、测试和生产构建。向 `main` 推送、创建 Pull Request 或推送版本标签都会触发 CI。

推送版本标签（例如 `v1.0.0`）即可发布 GitHub Release 和多架构 GHCR 镜像：`ghcr.io/axetroy/corvex:<版本>` 及 `:latest`。Release workflow 会先运行检查，再发布镜像和源码归档。
