# 运行环境与运维

## 运行环境要求

- 从源码构建或运行需要 Node.js 26.12.1 及 pnpm 12.4.1；使用 `pnpm install --frozen-lockfile` 按锁文件安装依赖。
- Server 需要访问 GitLab API；GitLab 必须能访问 Server 的 Webhook 地址。
- Worker 需要 `git` 可执行程序、GitLab API/仓库抓取的网络访问，以及（启用 Agent 时）访问模型 API 的 HTTPS 网络。项目提供的 Docker 镜像包含 Git。
- SQLite 与 Git 数据必须存储在持久且可写的卷中，不能依赖容器临时文件系统。Corvex 使用 SQLite WAL 模式；应选择可靠支持 SQLite 锁定的本地文件系统/卷，不要假定任意网络文件系统都适用。
- 保持系统时间同步。每日模型预算按 UTC 记账。

SQLite 通过 Node.js 内置的 `node:sqlite` 模块运行，不需要原生扩展或额外部署 SQLite 服务。构建 TypeScript 应用后，Server 与 Worker 作为两个独立进程运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- --config configs/config.yaml server
pnpm start -- --config configs/config.yaml worker
```

默认配置路径是 `configs/config.yaml`；可通过 `--config /path/to/config.yaml` 指定其他文件。`agent.enabled` 未设为 `true` 时 Worker 会拒绝启动。

## Docker Compose

1. 复制 `.env.example` 为 `.env`，设置 GitLab 写令牌和 Webhook Secret。只有运行 Worker 时才需要读取令牌和模型 API 密钥。妥善保护此文件，不要提交到版本控制。
2. 复制 `configs/config.example.yaml` 为 `configs/config.yaml`，填写 GitLab URL 和项目白名单；仅在需要禁止某些用户调用指令时，才填写 `gitlab.blocked_user_ids`。
3. 启动 Server：

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml pull corvex
   docker compose --env-file .env -f deploy/compose.yaml up -d
   ```

4. 如需处理模型任务，将 `agent.enabled` 设为 `true`，配置模型 URL/名称，并在 `.env` 中设置 `CORVEX_MODEL_API_KEY`，然后启用 Worker profile：

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml --profile worker pull
   docker compose --env-file .env -f deploy/compose.yaml --profile worker up -d
   ```

两个服务将同一命名卷 `corvex-data` 挂载到 `/data/corvex`；数据库和 Git 根目录都位于此卷中。只有 Server 映射 8080 端口。示例 Compose 使用只读容器根文件系统、临时 `/tmp`、移除 Linux capabilities 并启用 `no-new-privileges`。

Compose 默认使用 `ghcr.io/axetroy/corvex` 镜像。从本地代码构建时，可在 `docker compose up` 命令中添加 `--build`。
GHCR 的包可见性决定是否允许匿名拉取；如部署不应要求 `docker login`，首次发布后请将镜像包设为公开。

Compose 默认资源限制：Server 为 1 CPU/1 GiB、256 个 PID；Worker 为 2 CPU/2 GiB、256 个 PID。可通过 `CORVEX_MEM_LIMIT`、`CORVEX_CPUS`、`CORVEX_PIDS_LIMIT` 以及对应的 `CORVEX_WORKER_MEM_LIMIT`、`CORVEX_WORKER_CPUS`、`CORVEX_WORKER_PIDS_LIMIT` 覆盖。JSON 日志单个最大 10 MiB，保留 3 个文件。

通过 HTTPS 向 GitLab 暴露 Webhook，并在网络或代理层限制 GitLab API、数据库卷和指标端点的访问。Compose 端口映射使用普通 HTTP；请在可信反向代理或负载均衡器处终止 TLS。
只读运维控制台默认关闭；同时设置 `CORVEX_OPS_USERNAME` 和 `CORVEX_OPS_PASSWORD` 后，可访问 `https://<corvex-host>/ops`。相同凭据也保护其 API。请使用强且唯一的密码；不要通过普通 HTTP 或不可信网络暴露控制台。

## HTTP 接口

| 方法和路径 | 用途 |
|---|---|
| `POST /webhooks/gitlab` | GitLab 合并请求和 Issue Note Hook 接口，要求 `X-Gitlab-Token` 匹配；仅支持 Note Hook。 |
| `GET /healthz` | 进程存活检查，返回 `200 ok`。 |
| `GET /readyz` | SQLite 就绪检查；数据库不可用时返回 `503`。 |
| `GET /metrics` | Prometheus 文本格式指标，包含任务状态、模型调用次数、耗时和 Token 汇总。 |
| `GET /ops` | 可选的 Basic Auth 保护只读运维控制台；未配置运维凭据时禁用。 |
| `GET /api/ops/overview` | 运维概览：任务状态计数、最老排队时长、Worker 心跳和模型调用指标。 |
| `GET /api/ops/jobs` | 筛选/分页任务列表（`status`、`type`、`projectId`、`mrIid`、`search`、`limit`、`offset`）。 |
| `GET /api/ops/jobs/<id>` | 任务详情、持久化尝试历史、生命周期变化、Agent 轨迹及各执行步骤的输入/输出事件。 |

运维接口使用 HTTP Basic Auth；未启用时返回 `404`。任务详情包含发起人用户名和 ID、触发评论、解析后的请求及错误信息，应保护运维凭据并使用 HTTPS。触发评论来自关联的 Webhook 执行事件，并沿用其大小限制和尽力脱敏策略。除非监控系统需要，否则不要公开暴露 `/metrics`；应在网络或代理层限制访问。

控制台包含三个只读视图：队列和 Worker 状态概览、可筛选任务列表、单个任务及尝试历史详情。任务详情会分别显示发起人、触发评论和解析后的请求，并提供“会话”记录和原有的“轨迹”时间线。页面每 15 秒自动刷新，不提供重试、取消或创建任务操作。控制台是构建阶段打包到 `dist/app/ui` 的 React 应用；本地可用 `pnpm run ui:build` 构建，或用 `pnpm run ui:dev` 连接本地 Server 进行界面开发。`ui:dev` 会把 `/api` 代理到 `http://127.0.0.1:8080`，可用 `CORVEX_OPS_API` 指向其他 Server。任务列表的筛选条件（`status`、`type`、`search`）会写入 URL，刷新页面或分享链接后仍能还原。`/ops` 只响应 `GET` 和 `HEAD`，响应带严格的 Content Security Policy 与 `X-Robots-Tag: noindex`，避免控制台被索引或嵌入。
界面支持英文和简体中文。首次访问时会选择浏览器语言中受支持的语言；手动切换后会保存在浏览器中，供后续访问使用。

## 日志与故障排查

Corvex 将结构化 JSON 日志写到 stdout。在 Compose 中查看日志：

```sh
docker compose --env-file .env -f deploy/compose.yaml logs -f corvex
docker compose --env-file .env -f deploy/compose.yaml --profile worker logs -f corvex-worker
```

| 现象 | 检查项 |
|---|---|
| Webhook 返回 `401` | 确认 GitLab Hook Secret 与 `CORVEX_WEBHOOK_SECRET` 完全相同。 |
| Webhook 返回 `400` | 接口仅接受有效的合并请求或 Issue Note Hook；关闭不支持的事件，并确认请求来自合并请求或 Issue 评论。 |
| Webhook 返回 `403` | 确认 Webhook 项目 ID 和评论作者用户 ID 均在配置白名单中。 |
| 任务一直排队 | 确认 Worker 已启动、配置 `agent.enabled: true`、使用相同数据库卷/配置，并且模型配置有效。 |
| Worker 无法克隆项目 | 检查 GitLab 网络、只读令牌权限、项目可见性以及 Worker 上是否安装 Git。 |
| 任务变为 stale | 命令入队后 MR 已关闭或 Diff 已改变；应针对当前版本重新提交命令。 |
| `readyz` 返回 `503` | 检查数据库路径、持久卷挂载和文件系统权限。 |

## 任务管理

使用 Server 和 Worker 共享的 SQLite 数据库列出最近任务或筛选失败任务：

```sh
pnpm start -- jobs list --database ./data/state/corvex.db --status failed
pnpm start -- jobs list --database ./data/state/corvex.db --limit 100
```

仅允许重新排入发布前失败且仍有自动尝试次数的任务：

```sh
pnpm start -- jobs retry <job-id> --database ./data/state/corvex.db
```

发布阶段失败不能重试，因为 GitLab 可能已经接受了评论。CLI 会写入操作员重试审计事件；请在能访问持久数据库的主机上运行。

任务在发布阶段失败时，应将结果视为可能只部分生效。请在运维控制台打开任务详情，检查执行事件中的 `gitlab.post_discussion`、`gitlab.post_review_summary` 或 `gitlab.post_fix_proposal` 成功记录，再与 MR 中实际出现的评论逐项核对。不要重试失败任务：即使 Corvex 没收到响应，GitLab 也可能已接受评论，重试可能造成重复。目前 Corvex 不会恢复或对账单个发布步骤。如需重新执行，先确认哪些评论已经存在，并评估重复发布的风险。

Webhook 命令回复使用短期数据库发送租约，避免并发重投同时发布同一回复。但这不保证 exactly-once：如果 GitLab 已接受评论但响应丢失，租约到期后的重试仍可能产生重复评论。排查命令回复重复时，请检查事件的 `gitlab.post_note` 和 `webhook.mark_delivered` 步骤。

## Git 存储清理

先预览旧 worktree 和项目镜像，再决定是否删除：

```sh
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1 --apply
```

默认只做 dry-run；清理会跳过活动 worktree 以及有排队/运行任务的项目，只处理超过设定期限的目录。执行实际清理前请停止所有 Worker，避免与新领取的任务竞争。Compose 部署可在停止 Worker profile 后，从 Server 容器运行：

```sh
docker compose --env-file .env -f deploy/compose.yaml exec corvex \
  node /app/dist/cli.js storage cleanup --config /etc/corvex/config.yaml --apply
```

## 备份、恢复和保留期限

服务运行期间可以创建 SQLite 在线备份；输出文件必须不存在：

```sh
pnpm start -- backup \
  --database ./data/state/corvex.db \
  --output ./data/backups/corvex-$(date +%Y%m%d%H%M%S).db
```

容器部署时，应在可访问挂载数据库且安装了项目依赖的环境中运行备份命令。备份应采用与生产数据库相同的加密和访问控制策略。

恢复前停止 Server 和 Worker，先保留当前数据库用于回滚，再将已验证的备份替换到配置的数据库路径，然后重启两个进程。不要覆盖正在使用的数据库。

Server 启动时执行清理，之后约每 24 小时清理一次。终态任务、尝试记录、关联的执行步骤事件、Agent 轨迹、Webhook 投递记录及每日 Token 用量按 `storage.retention_days`（默认 90 天）清理；未关联任务的执行事件也按相同周期清理。审计记录按 `storage.audit_retention_days`（默认 365 天）清理。排队和运行中的任务会保留。执行事件输入/输出有大小限制，并会尽力脱敏类似凭证的内容。为在运维控制台完整呈现会话，Agent 轨迹会保留模型提示词与上下文、工具参数与结果以及模型输出；上下文条目在各轮之间增量存储，查看单轮详情时再重建完整上下文。轨迹可能包含仓库源码、diff、网页内容、评论或秘密信息，且不受执行事件的脱敏和大小限制保护。请妥善保护数据库和备份，通过 HTTPS 访问控制台，并严格限制操作员权限。`storage.root` 中的 Git 镜像不受数据库清理管理；请监控磁盘空间并单独制定镜像维护策略。

## 升级与开发

升级前先备份数据库。应用会在启动时执行 SQLite Schema 迁移；Server 和 Worker 应部署相同版本并继续使用共享数据卷。在生产环境依赖升级前，应使用备份验证升级和恢复流程。

在源码仓库中运行常用检查：

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

仓库 CI 使用 Node.js 26.12.1 运行这些检查。Worker 主机必须安装 Git。
