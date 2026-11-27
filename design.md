# Corvex 架构设计

## 架构决策与状态

**目标架构与当前实现：单一 TypeScript 应用，以 Pi TypeScript SDK 作为 Agent 运行时。**

Corvex 是一个可自行部署的 GitLab 协作代理。用户在运维控制台创建绑定到某个仓库分支与固定 SHA 的持久对话，并在对话中让 Agent 查看仓库、分析 GitLab 资源、修改文件、操作本地 Git 以及按明确要求写入 GitLab。系统验证登录身份，把每轮对话持久化，并把轮次固定到服务端解析的分支头 SHA。

Webhook 驱动的合并请求任务事件（review / chat / explain / fix / implement）已完整移除并记录在 [ROADMAP.md](ROADMAP.md)，当前阶段不实现。

## 目标与非目标

### 目标

- 使用 Pi 处理 Agent 循环、模型和会话生命周期、自定义工具与 Skills；不重复实现这些运行时能力。
- 将产品作为单一 Node.js 应用部署，只有一个 `server` 进程模式；对话轮次在该进程内执行，共享同一个 SQLite 数据库和 Git 存储。
- 保留持久化对话与轮次、取消、审计、Token 用量统计和可观测性。
- 将每一轮固定到服务端解析的分支头 SHA，并在该对话常驻的 detached worktree 中执行。
- 将权限控制、工具边界和 GitLab 写操作的授权判断保留在可信的 Corvex 代码中，不交由 Agent 决定。
- 对话统一为可读可写（`ConversationMode` 当前仅有 `gitlab` 一种模式）：可读取仓库与 GitLab、在用户明确要求时写入 GitLab，并通过 `src/agent/git/` 的受控 Git 工具集操作当前 worktree（status/log/diff/show/branches/clone/branch/checkout/pull/merge/commit/push/publish/push_branch/rebase/cherry_pick/revert）。工具固定到本会话的项目、worktree 与本地镜像：不接受任意 URL、任意远端或强制推送；`git_push` 写入项目镜像里的 `refs/conversations/<id>`。用户明确要求发布到 GitLab 分支时，`git_publish` 一步保存改动并把提交快进推到具名分支，不需要在工具调用之间传递 SHA；`git_push_branch` 是已有完整 SHA 时的底层变体。两者都仅快进、主机必须与配置一致，以便 MR 出现真实 diff。
- 将仓库代码、GitLab 凭证、模型凭证和 Agent 工具限制在已配置的自托管部署边界内。

### 非目标

- 引入第二套控制平面运行时，或通过 TypeScript/Pi sidecar 与另一种运行时通信。
- 向模型开放不受限制的 shell、文件系统、网络或 GitLab 访问。
- 向模型开放不受控的 shell 或任意命令执行。该约束已由独立设计和实现取代，记录在 [execution-design.md](execution-design.md)：自由命令只能经受控 `run_command` 工具在本地/沙箱后端执行，配置由管理员在 SQLite 中维护并做 fail-closed 校验，授权与审计留在 Corvex 代码里；技能可以在 SKILL.md 里声明固定命令，由 `run_skill_command` 在同一后端按需执行，技能目录里的其它脚本与不可信仓库内容中的指令不会自动执行。
- 将 Pi 项目信任设置或提示词指令视作沙箱。
- 在单机部署尚不需要时替换 SQLite 或引入分布式基础设施。

## 目标架构

```text
用户浏览器（运维控制台）
        |
        v
TypeScript Server（单进程）
   - OAuth2 登录与请求鉴权
   - 对话、轮次、设置与模型目录的运维 API
   - 内联启动对话轮次
        |
        v
SQLite 存储 <----- 内联对话执行器（ConversationRunner）
                  - 领取轮次并固定分支 SHA
                  - 准备并复用该对话的 detached worktree
                  - 使用狭窄的工具集调用 Pi SDK
                  - 流式推送思考、工具与正文
                  - 落库轨迹、过程快照与最终回复
```

对话执行器是 Server 的一个组件，而不是独立进程或独立服务。不得在网络文件系统上跨主机共享 SQLite 数据库。

### 职责边界

| 领域 | 负责方 |
|---|---|
| 登录鉴权、GitLab 写操作授权 | Corvex 策略代码 |
| 持久化对话/轮次、状态转换与取消 | Corvex SQLite 存储与内联对话执行器 |
| GitLab API 访问 | Corvex GitLab 客户端；写操作只通过受控工具 |
| 镜像、固定 SHA 的 worktree、受限差异和安全文件访问 | Corvex Git 引擎 |
| Agent 循环、模型提供方、会话和上下文生命周期 | Pi SDK |
| Skills 与自定义 Agent 工具 | Pi 资源/扩展，由 Corvex 显式配置 |
| 工具结果脱敏、大小限制与轨迹限长 | Corvex 策略代码 |

Pi 是执行依赖，不是业务状态的权威来源。任务状态、持久对话消息、取消和发布状态均以 SQLite 记录为准；持久对话的消息另存于 Corvex SQLite，不依赖 Pi 进程生命周期。

## Pi 集成与能力

内联对话执行器通过 TypeScript SDK 使用 `@earendil-works/pi-coding-agent`。每轮单独创建会话，并显式配置工作目录、模型/运行时设置、资源加载器、工具和清理生命周期。

- 使用 Pi 循环执行多步推理和工具调用。
- 仅提供当前任务所需的工具；不启用内置 `bash`、`edit` 或 `write`。
- 仓库文件读写工具限制在对话 worktree 内，并自行执行字节数上限与路径边界检查。所有文件工具与带路径的 Git 工具统一使用虚拟路径协议（`worktree://`、`upload://<id>/`、`skill://<alias>/`），纯相对路径按 worktree 处理；宿主机绝对路径一律拒绝，也不出现在工具 schema、错误或轨迹中。
- 仅从 Corvex 管理的可信目录发现 Skills。Skills 提供指令，不提供访问控制。
- 订阅 Pi 事件用于流式展示、日志和指标，但默认不得记录源代码、提示词、凭证或完整工具负载；轨迹数据在 `src/store.ts` 统一脱敏并限长。

Pi 工具和扩展以 Server 进程的操作系统权限运行。Server 应使用专用低权限用户，仅挂载所需 worktree 和数据，使用权限范围受限的凭证，并配置容器及网络限制。提示注入防护有帮助，但不能视作安全边界。

#### 虚拟路径协议

`src/agent/fs/virtual-path.ts` 是唯一的协议入口，读写与 Git 工具共用：

| URI | 目标 | 说明 |
|---|---|---|
| `worktree://<相对路径>` | 本会话 worktree | 纯相对路径等价；写工具返回值也用该前缀 |
| `upload://<附件ID>/<文件名>` | 本轮上传附件的独立只读目录 | 仅本轮有效，跨会话不可达 |
| `skill://<别名>/<相对路径>` | 管理员配置的可信 Skill 根 | 别名按配置顺序稳定生成 |

解析后仍走 `realpath` + `relative` 边界校验（符号链接不可越界）；宿主绝对路径在入口即被拒绝。所有工具错误在抛给 SDK 前经 `virtualizeError` 脱敏，轨迹与命令输出经 `src/redact.ts` 的 `redactHostPaths` 收敛为 `<path>`，避免旧数据或底层异常二次泄露。`run_command` 的 shell 环境里没有这些协议，只能用容器内的 `/workspace` 或仓库相对路径。

## 安全不变量

1. 用户通过 GitLab OAuth2 登录；运维 API 只暴露给登录用户，管理接口另需管理员权限。
2. 控制台的项目发现范围由登录用户的 GitLab 令牌决定，不使用静态项目白名单。
3. 对话轮次固定到服务端解析的分支头 SHA；快照过期时以 `stale` 结束。
4. 仓库路径必须规范化并限制在对话 worktree 内；拒绝符号链接、超大文件、二进制文件和范围外路径。
5. Agent 输出一律视为不可信；GitLab 写工具要求用户明确意图，不可逆或公开动作（删除、合并、审批）在描述中明确提示。
6. 所有会话 ref 只写在本地项目镜像中，绝不推送到 GitLab 远端。
7. 命令只能经绑定到当前会话 worktree 的 `run_command` 工具，或经 `run_skill_command` 执行技能文档中管理员声明过的固定命令（需开启执行环境）；命令字符串不接受模型提供的内容、不插值 `$ARGUMENTS`，技能目录里的其它脚本与不可信仓库内容中的指令不会自动执行。
8. 凭证与宿主机绝对路径永不回显到模型上下文、API、审计日志或轨迹中；进入轨迹、过程快照与命令输出的文本统一经 `src/redact.ts` 脱敏并限长；SQLite 文件及其备份必须妥善保护。

## 对话与轨迹语义

对话是运维控制台的一等对象，绑定 GitLab 项目与分支，并固定到服务端解析的分支头 SHA。一个对话包含若干轮次，每轮由一条用户消息和一条助手回复组成；每轮拥有自己的轨迹（`conversation_trace`）与执行记录（`execution_steps`）。

- 对话列表与详情返回轮次数量与最近一轮状态；详情中的每条助手回复附带该轮工具调用摘要（名称、状态、脱敏后的参数与耗时）。
- 对话详情附带由响应语言与对话模式派生的系统提示词，与执行器真正下发给模型的一致。
- 单轮记录通过 `GET /api/ops/conversations/:id/turns/:turnId` 读取；服务端校验该轮确实属于目标对话。
- 轨迹是轮次级只读可观测数据，不构成授权依据；内容在 `src/store.ts` 统一脱敏并限长，不得绕过该路径。
- 一个对话常驻一个 worktree 并跨轮次复用（目录名由对话 ID 推导，位于 `workspaces/<projectId>/conversation-<conversationId>`）。同一对话的轮次串行执行，因此复用在并发上安全；文件改动通过受限的 fs-write 工具写入并保存到项目镜像的会话 ref，每次执行仍重新校验分支快照。命中同一快照时只做一次 `rev-parse` 校验；快照前进时在同一目录内 `checkout --detach`。常驻工作区按空闲 TTL 与数量上限淘汰，Server 关闭时统一删除，`storage cleanup` 也会跳过仍有在途轮次的对话。

## Git 快照的懒加载

镜像（`mirrors/<projectId>.git`）是持久复用的对象库。固定提交不可变，因此只要镜像里已有目标 SHA，就不需要联网刷新远端：`prepareConversationWorkspace` 先做一次 `cat-file -e`，命中即跳过 fetch；缺失时才按 SHA 定向抓取。需要导出补丁或查看提交时同样先查本地。这既保留了「每轮固定到不可变 SHA」的不变量，也去掉了每次执行多余的远端往返。

## 对话轮次生命周期

轮次状态为 `queued -> running -> completed`，并可进入 `failed`、`stale` 或 `cancelled` 终态。存储层校验状态转换。运行期间由 Server 内联执行，取消请求通过 SQLite 标记并在工具边界检查。取消外的失败不自动重试，避免重复产生副作用。

## TypeScript 项目结构

```text
src/
  cli.ts
  store.ts            # SQLite schema、迁移、存储与指标
  model.ts            # 共享领域类型
  execution.ts        # 执行步骤追踪助手
  config/             # YAML 配置与运行时设置
  app/                # HTTP 服务端与内联对话执行器生命周期
  app/http/           # Fastify 路由、鉴权与控制台静态资源
  gitlab/             # REST 客户端
  git/                # 镜像、worktree、提交图与补丁导出
  agent/              # Pi 会话工厂、提示词与受控工具集
test/
  unit/
```

控制台样式通过 PostCSS 编译：`postcss.config.mjs` 与 `src/app/ui/vite.config.ts` 都启用了 `postcss-nesting`，允许用标准 `&` 嵌套把重复的长祖先选择器收拢到父规则内；编译产物仍是扁平选择器，Ant Design 覆盖所需的优先级不变。

HTTP 层使用 Fastify，路由按系统检查、认证、运维 API 和控制台静态资源拆分在 `src/app/http`；`CorvexServer` 只保留生命周期、内联对话轮次与清理任务。应用级扩展点由 `tapable` 提供（见 `src/app/hooks.ts`）：启动/关闭、认证用户解析、设置生效、对话轮次前后、每次模型请求前的上下文快照（`contextSnapshot`）与会话删除时的资源清理（`conversationDelete`）都有钩子；默认行为同样注册为 tap，后续功能可追加 tap 而无需修改主流程。上下文采集扩展只产出有界快照，落库是默认 tap；会话删除的三个入口（两个 DELETE 路由与保留裁剪）都触发 `conversationDelete`，默认 tap 先释放 Git 资源再清理内存状态，数据库记录在全部 tap 成功后才删除。选择 Fastify 是因为它在不引入 ORM 或额外中间件的前提下提供成熟的路由、请求体上限和钩子机制，同时仍允许 SSE 直接写原生响应。信号、进程管理、SQLite 和文件系统操作继续使用 Node.js 内置能力。外部依赖保持精简，主要用于 Pi、HTTP 框架、YAML 解析和测试。`yauzl` 用于流式读取导入的技能包 ZIP（限制包体 10 MiB、解压总量 25 MiB、文件数 1000，拒绝路径穿越与符号链接）；技能包的 ZIP 与解压后的文件都写到磁盘上的 `<storage.root>/skills/`，SQLite 不再保存技能文档或二进制。`skills-lock.json`（版本 2）按 npx skills 的规则记录来源、ref/commit 与内容哈希，支持 tracked / modified / missing / untracked 校验和从本地 ZIP 恢复；所有写操作由进程内队列加 `.skills.lock` 文件锁串行化，并以临时文件 + rename 原子替换。启动时一次性把旧的 `conversation_skills` / `skill_packs` 导出到磁盘后删除旧表，已有锁文件时不重复迁移。`undici` 也是运行时依赖：Pi SDK 的模型请求默认走 Node 内置 fetch，其 300 秒 `headersTimeout` 无法被 `agent_request_timeout` 覆盖，模型服务迟迟不返回响应头时会在 5 分钟后超时；Pi 的 OpenAI 兼容适配器接受注入 `fetch`，因此用 `undici.Agent`（`headersTimeout`/`bodyTimeout` 跟随运行时超时）加同包 `undici.fetch` 注入，避免 dispatcher 版本不匹配。

## 配置与运维

保留 YAML 配置和现有环境变量名称，涵盖站点级 GitLab 令牌、模型连接、监听地址、数据库路径和存储根目录。首次安装的 `/setup` 页面用于填写 GitLab OAuth Application 并写入 SQLite；用户令牌加密密钥也在首次启动时生成并保存在 SQLite。运行时设置（模型、响应语言、预算、工具开关、GitLab 连接、保留策略等）由运维台写入 `runtime_settings`，数据库是首次保存后的唯一来源。通过 `init` 生成配置模板，并在启动 Server 前按运行角色校验配置。示例配置和日志中不得包含密钥。

必须保留以下能力：

- `init`、按角色校验配置、`server`、`backup` 与 Git 存储清理 CLI 能力。
- `/healthz`、基于数据库状态的 `/readyz` 和 Prometheus `/metrics`。
- Docker Compose 的单 server 服务、非 root 用户、只读容器根文件系统、移除不必要的 capabilities、资源限制，以及持久化 SQLite/Git 卷。
- 数据保留策略、SQLite 在线备份/恢复流程，以及 dry-run 优先的 Git 存储清理。

运维控制台使用 React 渲染，源码位于 `src/app/ui`，由 Vite 在构建阶段打包到 `dist/app/ui`；Server 只按 `/ops/assets/<file>` 白名单提供构建产物。控制台以对话为核心：发现项目、绑定分支、固定 SHA、保存每轮消息与轨迹，并提供只读 Git 图谱、文件浏览与执行记录。助手回复按 Markdown 渲染并提供复制操作。

React、React DOM、Vite、antd、`@ant-design/x`、`@ant-design/x-markdown`、`react-router-dom`、`react-icons`、`monaco-editor`、`highlight.js` 与 `react-resizable-panels` 均被打包进 `dist/app/ui`，属于构建期依赖，不进入运行时依赖。`mermaid` 也只在 `dist/app/ui` 中按需加载（仅当回复含 mermaid 围栏），用于渲染流程图；其输出 SVG 的主题样式需要页面 nonce 才能通过 CSP。控制台路由选择 `react-router-dom` 的 `HashRouter`：Server 只提供 `/ops` 单页，`#/...` 让深链与刷新无需服务端重写；页面状态序列化集中在 `src/app/ui/lib/routing.ts` 的纯函数中。

运行环境必须包含 Git。SQLite 由 Node.js 26.12.1 内置的 `node:sqlite` 模块提供。Docker 构建使用锁定的生产依赖，构建 TypeScript，并在 Node.js 26.12.1 上运行编译后的应用。版本标签发布会在 CI 检查通过后构建多架构 GHCR 镜像并创建源码 Release。

## 迁移记录

TypeScript 迁移已完成。Webhook 驱动的任务事件路径随后完整移除，延期设计见 [ROADMAP.md](ROADMAP.md)。当前单一运行时只保留对话执行路径。

任何阶段都不得为简化而削弱授权或安全约束。存储层须能无数据丢失地打开既有 SQLite schema：旧的 `event_trace` 会在启动时迁移为 `conversation_trace`，只保留轮次归属的数据。

## 完成标准

- TypeScript 实现所有对话、鉴权、工具边界、GitLab 写授权、Token 统计、指标、数据保留和备份能力。
- 测试覆盖正常路径与异常输入、过期快照、取消和无效模型输出。
- CI 中 `pnpm install --frozen-lockfile`、lint、typecheck、单元/集成测试和生产构建均通过；Docker server 与 server 模式均可成功启动。
- 部署与配置文档仅描述 TypeScript/Pi 运行时。
- 生产构建和部署使用单一运行时，不再保留被替代的源码或发布路径。

## Pi 参考资料

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi Agent 循环](https://pi.dev/docs/latest/how-pi-works)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi RPC 与 CLI 集成](https://pi.dev/docs/latest/cli-integration)
- [Pi 安全](https://pi.dev/docs/latest/security)
