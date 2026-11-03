# 快速开始

Corvex 是面向 GitLab 合并请求的自托管代码审查与修复代理，包含两个进程：

- **Server** 接收 GitLab Note Hook 事件，校验访问权限，将任务写入 SQLite，并回复评论。
- **Worker** 从 SQLite 领取任务，读取合并请求的固定版本；需要时调用 OpenAI 兼容模型，并发布结果。

Server 可以独立运行，但没有 Worker 时，审查、解释和修复任务会一直排队。详细内容请参阅[架构与工作流程](./architecture)、[配置参考](./configuration)和[运行环境与运维](./operations)。

## 环境要求

- 从源码运行需要 Node.js 26.12.1 和 pnpm 12.4.1；使用 `pnpm install --frozen-lockfile` 按锁文件安装依赖。
- Server 和 Worker 必须能够访问 GitLab；GitLab 必须能访问 Webhook 地址。
- GitLab 只读令牌用于 API 读取和仓库抓取；独立的写令牌用于发布 MR 评论和讨论。
- Worker 主机需要 `git` 可执行程序；项目提供的 Docker 镜像已安装 Git。
- 启用 Agent 时，需要 OpenAI 兼容 Chat Completions 接口及 API 密钥；Agent Runtime 由 Pi SDK 提供。
- SQLite 数据库和 Git 镜像目录必须位于重启后仍保留且可写的存储中。

## 1. 准备配置和密钥

构建 CLI 并初始化配置模板：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

编辑 `configs/config.yaml`，填写 GitLab URL 和项目白名单。只有需要禁止某些用户调用指令时，才将其数字 ID 加入 `gitlab.blocked_user_ids`。为 Server 设置以下变量：

```sh
export CORVEX_GITLAB_TOKEN='写入令牌'
export CORVEX_WEBHOOK_SECRET='足够长的随机密钥'
```

ID 使用 GitLab 数字 ID；两个白名单都必须非空，空白名单不表示“允许所有人”。不要把凭据写入 YAML 或提交到源代码仓库。所有配置及边界值请参阅[配置参考](./configuration)。

Server 只需要写令牌和 Webhook Secret。Worker 还需要 `CORVEX_GITLAB_READ_TOKEN`；启用 Agent 时，还需要 `CORVEX_MODEL_API_KEY`。只读令牌用于读取项目/MR API 和抓取仓库；请使用独立读写令牌并只授予所需权限。

## 2. 启动 Server

```sh
pnpm start -- --config configs/config.yaml check-config
pnpm start -- --config configs/config.yaml server
```

默认监听 `0.0.0.0:8080`。对 GitLab 提供公网服务时，应通过 HTTPS 暴露，并使用适当的网络访问控制；不要将服务直接暴露给不可信网络。

## 3. 配置 GitLab Webhook

创建项目 Webhook，地址为：

```text
https://corvex.example.com/webhooks/gitlab
```

Webhook Secret Token 应与 `CORVEX_WEBHOOK_SECRET` 完全一致。启用 **Comments（评论/Note 事件）**；当前接口只处理合并请求上的评论，不处理合并请求状态事件或 Push 事件。保持 SSL 证书验证开启。

可使用 `scripts/register-webhook.sh` 幂等地创建或更新项目 Webhook。脚本需要 `curl`、`jq`，以及仅用于注册的 GitLab 管理员令牌：

```sh
GITLAB_URL=https://gitlab.example.com \
GITLAB_ADMIN_TOKEN=... \
GITLAB_PROJECT_ID=101 \
CORVEX_WEBHOOK_URL=https://corvex.example.com/webhooks/gitlab \
CORVEX_WEBHOOK_SECRET=... \
./scripts/register-webhook.sh
```

运行中的 Corvex 服务不需要管理员令牌。

## 4. 在合并请求评论中使用命令

先 @ GitLab 机器人账号，再使用以 `/` 开头的指令。账号名由 `gitlab.bot_username` 配置（例如 `corvex-bot`）：

| 命令 | 功能 |
|---|---|
| `@corvex-bot /review [补充说明]` | 将当前合并请求版本加入审查队列，可附加指令、示例或其他上下文。 |
| `@corvex-bot /explain path/to/file.ts` | 解释合并请求固定 Head SHA 中的指定文件。 |
| `@corvex-bot /status` | 查看该合并请求最近任务的状态。 |
| `@corvex-bot /cancel` | 取消排队任务，或请求取消自己发起的运行中任务。 |
| `@corvex-bot /fix Make this error easier to handle` | 请求生成受限修复提案；要求已启用 Fix 且用户未被拉黑。 |

`/review` 可附加最多 2,000 个字符的补充说明；正文中的换行、缩进和连续空格会原样保留，因此也可以包含多行示例。`/status` 和 `/cancel` 不接受参数；`/explain` 接受一个路径；`/fix` 可附带自然语言请求。项目白名单中的任意评论者都可调用指令，除非其 ID 在 `gitlab.blocked_user_ids` 中。

## 5. 启用模型任务

审查、解释和修复提案需要 Worker 及模型配置。设置 `agent.enabled: true`、`agent.base_url`、`agent.model`，并提供 `CORVEX_MODEL_API_KEY`。Base URL 是 API 根地址；Corvex 会请求其 `/chat/completions` 路径。

在另一个进程中启动：

```sh
pnpm start -- --config configs/config.yaml --for worker check-config
pnpm start -- --config configs/config.yaml worker
```

Agent 关闭时，Server 仍可接收事件并持久化任务，但 Worker 会拒绝启动。可通过[运行环境与运维](./operations)中的健康检查接口测试本地 Server。

## 谨慎启用修复提案

Fix 默认关闭。启用时，将 `fix.enabled` 设为 `true` 并启用 Agent。项目白名单中未被拉黑的评论者均可请求提案。模型只能针对 MR Diff 中已变更的文本文件提出补丁。Corvex 会在一次性隔离 worktree 中校验并应用补丁，然后将补丁发布给人工审阅和应用。它**不会**运行仓库代码或测试、创建提交或推送变更。提案不代表项目测试已通过。

Pi Session 不开放内建 shell、编辑或写入工具。只读仓库工具包括支持连续游标的有界 `read_file`、搜索固定 HEAD 已跟踪文件的 `git_grep`（10 秒超时、256 KiB 输出上限、最多 50 条），以及可搜索工作树和可信 Skill 根目录的字面量 `search_text`（每次最多扫描 1,000 个文件和 16 MiB，返回最多 50 条匹配）。启用后，`web_fetch` 仅对 review 和 explain 任务开放；私网/保留地址始终拦截，`agent.web_blocked_hosts` 可增加主机黑名单，每个 Session 最多抓取 10 页。重定向会重新校验，网页内容属于不可信输入。`agent.skill_paths` 用于加载 Skill。MCP 默认关闭；启用 `agent.mcp_enabled` 后仅为 review 任务从服务的 Pi Agent 目录加载 MCP 工具。MCP 服务进程拥有 Worker 的操作系统权限；仅使用管理员控制的配置，且不要将 MCP 当作沙箱。

## 后续阅读

- 阅读[架构与工作流程](./architecture)，了解任务处理、重试和安全边界。
- 查阅[配置参考](./configuration)中的全部配置项。
- 按照[运行环境与运维](./operations)配置 Docker Compose、健康检查、备份、保留策略和故障排查。
