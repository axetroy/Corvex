# 运行环境与运维

## 运行环境要求

- 从源码构建或运行需要 Node.js 26.12.1 及 pnpm 12.4.1；使用 `pnpm install --frozen-lockfile` 按锁文件安装依赖。
- Server 需要出站访问 GitLab API（OAuth、项目与分支发现、仓库抓取）与配置的模型 API；用户浏览器需要能访问 `/ops`。不需要入站 Webhook 地址。
- Server 需要 `git` 可执行程序用于对话的仓库操作。项目提供的 Docker 镜像包含 Git。
- SQLite 与 Git 数据必须存储在持久且可写的卷中，不能依赖容器临时文件系统。Corvex 使用 SQLite WAL 模式；应选择可靠支持 SQLite 锁定的本地文件系统/卷，不要假定任意网络文件系统都适用。
- 保持系统时间同步。每日模型预算按 UTC 记账。

SQLite 通过 Node.js 内置的 `node:sqlite` 模块运行，不需要原生扩展或额外部署 SQLite 服务。构建 TypeScript 应用后，启动单进程 Server（HTTP 与内联对话）：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- --config configs/config.yaml server
```

默认配置路径是 `configs/config.yaml`；可通过 `--config /path/to/config.yaml` 指定其他文件。启动前可用 `check-config --config ... [--for server|storage]` 校验配置。CLI 仅有 `init`、`check-config`、`server`、`backup` 和 `storage cleanup`；Webhook 事件及其 `events` 命令已延期，见 [ROADMAP.zh_CN.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.zh_CN.md)。

## Docker Compose

1. `.env` 只用于可选的启动兜底（GitLab 读/写令牌与模型 API Key）；建议把凭据保存在运维台设置页。妥善保护此文件，不要提交到版本控制。
2. 复制 `configs/config.example.yaml` 为 `configs/config.yaml`；GitLab 地址与 OAuth 凭据在安装页填写。每个用户只能搜索到自己 GitLab 令牌可见的项目。
3. 启动 Server：

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml pull corvex
   docker compose --env-file .env -f deploy/compose.yaml up -d
   ```

4. 如需处理模型任务，在运维台配置模型及其 API Key，然后重建 Server 容器：

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml up -d --force-recreate corvex
   ```

单个服务将命名卷 `corvex-data` 挂载到 `/data/corvex`；数据库和 Git 根目录都位于此卷中，并映射 8080 端口。示例 Compose 使用只读容器根文件系统、临时 `/tmp`、移除 Linux capabilities 并启用 `no-new-privileges`。

Compose 默认使用 `ghcr.io/axetroy/corvex` 镜像。从本地代码构建时，可在 `docker compose up` 命令中添加 `--build`。GHCR 的包可见性决定是否允许匿名拉取；如部署不应要求 `docker login`，首次发布后请将镜像包设为公开。

Compose 默认资源限制为 1 CPU/1 GiB、256 个 PID。可通过 `CORVEX_MEM_LIMIT`、`CORVEX_CPUS`、`CORVEX_PIDS_LIMIT` 覆盖。JSON 日志单个最大 10 MiB，保留 3 个文件。

Compose 端口映射使用普通 HTTP；请在可信反向代理或负载均衡器处终止 TLS。把 GitLab API、数据库卷和指标端点限制在可信网络内。运维台地址为 `/ops`，首次安装会跳转到 `/setup` 填写 GitLab OAuth Application 凭据；回调地址必须使用 HTTPS，并与 GitLab 应用登记一致。

## HTTP 接口

| 方法和路径 | 用途 |
|---|---|
| `GET /healthz` | 进程存活检查，返回 `200 ok`。 |
| `GET /readyz` | SQLite 就绪检查；数据库不可用时返回 `503`。 |
| `GET /metrics` | Prometheus 文本格式指标，仅含模型调用次数、耗时与输入/输出 Token 汇总；没有事件指标。 |
| `GET /ops`、`/ops/*` | 运维台；需要 GitLab OAuth2 登录，响应带严格的 Content Security Policy 与 `X-Robots-Tag: noindex`。 |
| `GET /auth/gitlab`、`GET /auth/gitlab/callback`、`POST /auth/logout` | GitLab OAuth2 登录、回调与登出。 |
| `GET /api/auth/status` | 公开的 200-only 状态探测，供前端路由守卫判断 `authenticated` / `setupRequired`。 |
| `GET /api/auth/me` | 当前登录用户信息；OAuth 未配置时返回带 `setupRequired` 的 401 JSON，控制台会跳到 `/setup` 而不是不可用的登录页。 |
| `GET /api/setup/status`、`POST /api/setup/oauth` | 安装向导；仅在 OAuth 未配置时可写，凭据保存在 SQLite。 |
| `GET /api/ops/overview` | 概览：对话轮次健康度、最老排队轮次时长、模型调用指标。 |
| `GET /api/ops/projects`、`GET /api/ops/projects/<id>`、`GET /api/ops/projects/<id>/branches` | 搜索当前用户可见的项目、读取仓库信息（对话上方的信息弹窗）与分支。 |
| `GET /api/ops/conversations`、`GET /api/ops/conversations/<id>` | 列出持久对话（含轮次数与最近一轮状态）及消息；详情还附带派生的系统提示词。 |
| `POST /api/ops/conversations`、`POST /api/ops/conversations/<id>/messages` | 创建固定版本的可读可写对话，或排入下一轮。 |
| `POST /api/ops/conversations/<id>/archive`、`DELETE /api/ops/conversations/<id>` | 归档/取消归档，或删除对话（轮次运行中拒绝）。 |
| `GET /api/ops/conversations/<id>/turns`、`GET /api/ops/conversations/<id>/turns/<turnId>` | 读取整段对话合并后的时间线，或单轮的轨迹与执行记录（校验归属）。 |
| `GET /api/ops/conversations/<id>/turns/<turnId>/stream` | SSE：运行中轮次的累计助手正文（`text`）、思考（`thinking`）、工具执行（`tool`）、上下文变化（`context`）与最终 `done`。 |
| `POST /api/ops/conversations/<id>/turns/<turnId>/cancel` | 请求取消排队或运行中的轮次。 |
| `GET /api/ops/conversations/<id>/stats` | 整段对话的用量与耗时汇总，含逐轮明细。 |
| `GET /api/ops/conversations/<id>/context`、`.../context/<seq>` | 按请求记录的上下文快照概要（不含条目预览）或单次请求的完整有界条目。 |
| `GET /api/ops/conversations/<id>/files/tree`、`/files/content`、`/files/image` | 文件面板的目录、文本与图片读取；图片响应带 `x-corvex-file-source` 标明来源。 |
| `GET /api/ops/conversations/<id>/git/graph`、`/git/authors`、`/git/commit/:sha`、`/git/commit/:sha/patch` | Git 图谱、作者筛选、提交详情与补丁下载。 |
| `GET`/`DELETE /api/ops/conversations/<id>/changes` | 查看或删除会话改动 ref（`refs/conversations/<id>`）。 |
| `GET /api/ops/storage/cleanups`、`POST /api/ops/storage/cleanup` | 最近的清理记录；预览（`apply: false`）或执行（`apply: true`）清理，运行中/排队中的轮次受保护。 |
| `GET`/`POST /api/ops/model-providers` | 列出或新增系统级模型供应商；不回显 API Key。 |
| `PUT`/`DELETE /api/ops/model-providers/<id>` | 修改或删除供应商；`apiKey` 留空保留原值。 |
| `POST /api/ops/model-providers/<id>/models`、`PUT`/`DELETE /api/ops/model-providers/<id>/models/<modelId>` | 供应商下模型的增删改。 |
| `POST /api/ops/model-providers/<id>/models/<modelId>/activate` | 选择全局激活模型；第一个新增模型默认激活。 |
| `POST /api/ops/model-providers/test`、`POST /api/ops/model-providers/<id>/models/test` | 连接测试；结果不回显密钥。 |
| `GET`/`POST /api/ops/me/model-providers` 及子路径 | 当前用户私有的模型供应商与激活选择，不影响系统级模型。 |
| `GET`/`PUT /api/ops/settings` | 读取运行时设置的生效值，或整份替换；首次保存后 SQLite 即为唯一来源，是否提供 `--config` 都可用。 |

运维台接口需要 GitLab OAuth2 会话；API 遇到未登录返回 401 JSON（永不 302），前端据此重定向到登录或安装页。请保护会话并使用 HTTPS。除非监控系统需要，否则不要公开暴露 `/metrics`；应在网络或代理层限制访问。不存在 `/webhooks/gitlab` 或 `/api/ops/events` 端点。

控制台以对话为主，默认打开「对话」页，列表按仓库分组展示轮次数与最近一轮状态。外壳铺满视口：左侧为可折叠导航（品牌、语言与主题选择，均提供「跟随系统」及明确选项并保存在 `localStorage`），主区域占据剩余宽度，无页脚。新建对话使用带搜索的仓库与分支选择器；欢迎页提供按意图分组的快捷提示词，点击后填入输入框。每轮固定到服务端解析的分支头 SHA，消息保存在 SQLite，并可用仓库读写工具与项目/Issue/MR 工具，在用户明确要求时向 GitLab 写入。工作区把仓库信息与 **Chat**、**调用记录**、**轨迹**、**上下文**、**统计**、**变更**、**Git 图谱**、**文件面板** 放在同一行：Chat 流式呈现 Markdown 回复与交错的思考/工具时间线，展示系统提示词，已完成的回复附复制按钮、TPS、耗时与模型标签；轨迹默认合并全部轮次，可聚焦单轮，按轮分段、每段自带标尺，支持缩放与框选；「上下文」标签按请求展示窗口占用、组成条、请求时间线、逐项脱敏预览与上下文事件，选中请求后各区块同步更新，采集可在「设置 → 预算」关闭；文件面板默认读取本地工作区，必要时回退到 GitLab 接口并显示来源。输入框默认三行，底栏内置模型切换器，选择后立即作用于下一轮；斜杠命令只是本轮模型指令，不创建状态也不发布。系统级概览位于管理后台（`#/admin/overview`）；每个用户还有个人设置页（`#/settings`）管理私有模型。对话列表、Git 图谱与文件面板的布局可在 `localStorage` 中持久化。控制台是构建阶段打包到 `dist/app/ui` 的 React 应用；本地可用 `pnpm run ui:build` 构建，或用 `pnpm run ui:dev` 连接本地 Server 进行界面开发（`ui:dev` 把 `/api` 代理到 `http://127.0.0.1:8080`）。`/ops` 只响应 `GET` 和 `HEAD`。

界面支持英文和简体中文。首次访问时会选择浏览器语言中受支持的语言；手动切换后会保存在浏览器中，供后续访问使用。

## 日志与故障排查

Corvex 将结构化 JSON 日志写到 stdout。在 Compose 中查看日志：

```sh
docker compose --env-file .env -f deploy/compose.yaml logs -f corvex
```

Server 记录 OAuth 登录、对话轮次的领取与状态变化、模型调用与 GitLab 客户端错误，但不记录评论正文或令牌值。

| 现象 | 检查项 |
|---|---|
| 访问 `/ops` 一直跳回安装页 | 确认 `/setup` 中 GitLab 地址、OAuth Application ID/Secret 与回调地址齐全且正确，并与 GitLab 应用登记一致。 |
| OAuth 登录后报 `401` | 检查用户令牌权限与会话 Cookie；API 未登录时返回 401 JSON，前端会重定向到 `/auth/gitlab`。 |
| 项目列表为空 | 检查 GitLab 令牌的项目可见范围；运维台没有静态项目白名单。 |
| 轮次一直排队 | 检查模型配置是否有效、Server 日志中的错误，以及概览中的执行器心跳。 |
| 轮次变为 `stale` | 消息入队后分支头 SHA 已变化；重新发送消息即可使用当前版本。 |
| Server 无法克隆项目 | 检查 GitLab 网络、令牌权限、项目可见性以及 Server 主机是否安装 Git。 |
| GitLab 写入被拒绝 | 写操作需要用户明确意图，且需要相应的读/写令牌；`git_push` 只写镜像中的会话 ref；`git_push_branch` 需要用户明确要求且只能快进。 |
| `readyz` 返回 `503` | 检查数据库路径、持久卷挂载和文件系统权限。 |

## 对话轮次管理

对话及其轮次通过运维台和 `/api/ops/conversations` 管理，没有事件 CLI 命令。运行中或排队的轮次可在 Chat 输入框点击 **Stop**，或调用取消端点；取消后可在「调用记录」与「轨迹」中查看该轮的最终状态。右键对话列表项可归档/取消归档或删除；删除会同时移除 worktree 与会话 ref，且轮次运行时会被拒绝。进程崩溃后重启时残留的在途轮次会被标记为失败，需要重新发送消息才能重试。Webhook 事件的管理命令已延期，见 [ROADMAP.zh_CN.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.zh_CN.md)。

## Git 存储清理

先预览旧 worktree 和项目镜像，再决定是否删除：

```sh
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1 --apply
```

默认只做 dry-run；清理会跳过活动 worktree、仍有排队或运行中轮次的对话，以及被对话引用的项目镜像，只处理超过设定期限的目录。执行实际清理前请停止 Server，避免与正在执行的轮次竞争。Compose 部署可从 Server 容器运行：

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

恢复前停止 Server，先保留当前数据库用于回滚，再将已验证的备份替换到配置的数据库路径，然后重启 Server。不要覆盖正在使用的数据库。

Server 启动时执行清理，之后约每 24 小时清理一次。已结束的对话轮次、轨迹、执行步骤与每日 Token 用量按 `storage.retention_days`（默认 90 天）清理；审计记录按 `storage.audit_retention_days`（默认 365 天）清理。排队和运行中的轮次会保留。空闲超过保留期的对话连同消息一并删除，但仍有排队或运行中轮次的对话不会被丢弃。轨迹为在控制台完整呈现会话，会保留模型提示词与上下文、工具参数与结果及模型输出，且会脱敏并限长；其中仍可能包含仓库源码、diff、网页内容或秘密信息。请妥善保护数据库和备份，通过 HTTPS 访问控制台，并严格限制操作员权限。`storage.root` 中的 Git 镜像、worktree 与会话 ref 不受数据库清理管理；孤儿 ref 与不可达对象由单独的 ref 清理和镜像 GC 回收，请监控磁盘空间并制定相应维护策略。

## 升级与开发

升级前先备份数据库。应用会在启动时执行 SQLite Schema 迁移；Server 应部署相同版本并继续使用数据卷。在生产环境依赖升级前，应使用备份验证升级和恢复流程。

在源码仓库中运行常用检查：

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

仓库 CI 使用 Node.js 26.12.1 运行这些检查。Server 主机必须安装 Git。
