# Corvex 架构设计

## 架构决策与状态

**目标架构与当前实现：单一 TypeScript 应用，以 Pi TypeScript SDK 作为 Agent 运行时。**
在不保留已替换运行时遗留物的前提下，维持现有用户可见行为和安全边界。

Corvex 是一个可自行部署的 GitLab 合并请求（MR）审查与修复建议助手。用户在
GitLab MR 评论中提及 `@corvex`，并发送 `review`、`explain <path>`、`fix`、
`status` 或 `cancel` 命令。运维控制台还提供绑定到 GitLab 项目与分支固定 SHA 的
持久只读对话。系统会验证请求身份和权限，将请求持久化，针对确切的目标版本进行分析，
并按对应工作流校验或保存结果。

## 目标与非目标

### 目标

- 使用 Pi 处理 Agent 循环、模型和会话生命周期、自定义工具、Skills，以及可选的
  MCP 集成；不重复实现这些运行时能力。
- 将产品作为单一 Node.js 应用部署，只有一个 `server` 进程模式；Webhook 事件与
  对话轮次都在该进程内执行，共享同一个 SQLite 数据库和 Git 存储。
- 保留持久化任务、Webhook 幂等性、租约、取消、重试策略、审计、Token 用量统计和
  可观测性。
- 将每项任务固定到 MR 的准确 base/head SHA，并在独立的 detached Git worktree 中
  执行。
- 将权限控制、结果校验、补丁范围检查和发布决策保留在可信的 Corvex 代码中，不交由
  Agent 决定。
- 通过运维控制台创建持久对话，发现范围由 GitLab 只读 Token 的可见项目决定；对话绑定
  仓库分支，每轮固定到服务端解析的分支头 SHA。对话的仓库能力由显式模式
  （`ConversationMode`）数据驱动：当前仅有 `read_only` 一种模式，不提供仓库写入或
  GitLab 发布。对话是运维控制台
  的一等对象：每一轮都保留自己的轨迹与执行记录，可在对话内直接查看。
- 将仓库代码、GitLab 凭证、模型凭证和 Agent 工具限制在已配置的自托管部署边界内。

### 非目标

- 引入第二套控制平面运行时，或通过 TypeScript/Pi sidecar 与另一种运行时通信。
- 向模型开放不受限制的 shell、文件系统、网络、GitLab 或 MCP 访问。
- 在当前修复建议流程中执行仓库脚本、提交更改、推送分支或合并 MR。
- 将 Pi 项目信任设置或提示词指令视作沙箱。
- 在单机部署尚不需要时替换 SQLite 或引入分布式基础设施。

## 目标架构

```text
GitLab 评论 Webhook
       |
       v
TypeScript Server（单进程）
  - 验证 Webhook 令牌和事件
  - 过滤机器人及系统评论
  - 检查可选用户阻止列表
  - 解析命令并创建幂等任务
  - 提供运维 API 和持久对话工作台
       |
       v
SQLite 任务/对话存储 <----- 内联事件执行器（EventRunner）
                         - 领取租约、心跳、处理取消和重试
                         - 获取当前 MR 或对话目标及固定版本
                         - 准备隔离的 detached worktree
                         - 使用任务专属工具调用 Pi SDK
                         - 校验输出并重新确认 MR 版本
                         - 只读对话不提供仓库写入或 GitLab 发布
                         - 其他授权工作流按策略校验和发布结果
```

事件执行器是 Server 的一个组件，而不是独立进程或独立服务。租约仍然存在，用于表达
事件生命周期、取消与崩溃恢复；因为是单进程部署，Server 启动时可以立即回收上次进程
留下的在途事件，不必等待租约自然过期。不得在网络文件系统上跨主机共享 SQLite 数据库。

### 职责边界

| 领域 | 负责方 |
|---|---|
| Webhook 验证、命令解析、用户阻止列表和能力授权 | Corvex 策略代码 |
| 持久化任务/对话、幂等性、租约、状态转换、重试和取消 | Corvex SQLite 存储与内联事件执行器 |
| GitLab API 访问和评论发布 | Corvex GitLab 客户端 |
| 镜像、固定 SHA 的 worktree、受限差异和安全文件访问 | Corvex Git 引擎 |
| Agent 循环、模型提供方、会话和上下文生命周期 | Pi SDK |
| Skills、自定义 Agent 工具和可选 MCP 集成 | Pi 资源/扩展，由 Corvex 显式配置 |
| 发现项/补丁校验、版本复核和发布决策 | Corvex 策略代码 |

Pi 是执行依赖，不是业务状态的权威来源。Pi 会话用于 Agent 上下文和诊断；任务状态、
持久聊天轮次、重试、审计、取消和发布状态均以 SQLite 记录为准。独立任务使用一次性
Pi 会话；持久对话的消息另存于 Corvex SQLite，不依赖 Pi 进程生命周期。

## Pi 集成与能力

内联事件执行器通过 TypeScript SDK 使用 `@earendil-works/pi-coding-agent`。每项任务单独创建
会话，并显式配置工作目录、模型/运行时设置、资源加载器、工具和清理生命周期。

- 使用 Pi 循环执行多步推理和工具调用。
- 仅提供当前任务所需的工具。审查或修复建议任务不得启用内置 `bash`、`edit` 或
  `write` 工具。
- 将自定义工具限制在狭窄用途内，例如读取固定 worktree 中经过校验的路径，或获取已
  授权的 MR 元数据。工具实现自身必须执行字节数上限和路径边界检查。
- 仅从 Corvex 管理的可信目录发现 Skills。Skills 提供指令，不提供访问控制。
- MCP 按部署和任务类型选择启用。通过 SDK 资源加载器显式注册 Pi 的 MCP 扩展；校验
  服务端配置，并且只暴露获批的服务和工具。不得默认认为任意 MCP 工具都是安全的。
- 以严格的结构化格式接收 Agent 输出。发现项必须与新增差异行核对；在本地应用或发布
  前，必须校验补丁路径和内容。
- 订阅 Pi 事件用于日志和指标，但默认不得记录源代码、提示词、凭证或完整工具负载。

Pi 工具和扩展以 Server 进程的操作系统权限运行。Server 应使用专用低权限用户，仅挂载所需
的 worktree 和数据，使用权限范围受限的凭证，并配置容器及网络限制。提示注入防护有
帮助，但不能视作安全边界。

## 安全不变量

1. 以恒定时间比较 Webhook 密钥，并限制请求体大小。
2. Webhook Secret 用于认证投递；只在需要接受指令的项目中注册 Webhook。运维控制台的
  项目发现范围由 GitLab 只读 Token 决定，不使用静态项目白名单；可选用户阻止列表
  由 Corvex 强制执行。
3. 机器人和系统评论不得创建任务；重复的 Webhook 事件必须保持幂等。
4. `fix` 请求必须满足修复模式已启用（`fix.enabled`，且要求 `agent.enabled`）。
5. 任务记录完整的 MR Head SHA；获取差异、准备 worktree 和发布时均须验证预期快照。
6. 仓库路径必须规范化并限制在任务 worktree 内；在适用场景下拒绝符号链接、超大文件、
   二进制文件和范围外路径。
7. Agent 输出一律视为不可信。发现项必须精确引用新增行。修复补丁仅限变更路径、受大小
   限制，并通过 `git apply --check` 和 `git diff --check` 检查。
8. Agent 不得直接发布。发布前由 Corvex 重新检查授权、任务取消状态和 MR 版本，并使用
   仅具备写入所需权限的 Token。
9. 外部发布结果不确定时不得盲目重试。
10. 不执行仓库命令或脚本。若要增加执行器，必须单独设计沙箱和显式授权模型。

## 对话与轨迹语义

对话是运维控制台的一等对象，绑定 GitLab 项目与分支，并固定到服务端解析的分支头
SHA。一个对话包含若干轮次，每轮由一条用户消息和一条助手回复组成；每轮回复对应一个
`conversation` 任务，因此每轮都拥有自己独立的轨迹（`job_trace`）与执行记录
（`execution_events`）。

- 对话列表与详情返回轮次数量与最近一轮状态，让控制台无需额外请求即可概览对话进展；
  详情中的每条助手回复还会带上该轮工具调用摘要（名称、状态、脱敏后的参数与耗时），
  使对话页可以直接展示本轮读过哪些文件、调用是否成功，而无需切到轨迹标签。
  摘要只读取列表所需的轨迹字段并限长，完整轨迹仍只在单轮记录接口中读取。
- 对话详情还附带由响应语言与对话模式派生的系统提示词，与执行器真正下发给模型的一致；
  服务端在详情响应中现算，因此尚未执行过任何轮次的新对话也能在控制台查看。
- 单轮记录通过 `GET /api/ops/conversations/:id/turns/:jobId` 读取；服务端校验该任务
  确实属于目标对话的助手回复，避免跨对话读取轨迹。
- 轨迹是任务级的只读可观测数据，不构成授权依据；每轮对话的轨迹与记录随任务终态固定
  下来，不因后续轮次或对话状态变化而改变。
- 对话的仓库能力由显式模式决定，而不是散落的硬编码假设：`read_only` 模式不发布到
  GitLab，也不写入 worktree。轨迹内容在 `src/jobs/store.ts`
  统一脱敏并限长，不得绕过该路径。
- 一个对话常驻一个只读 worktree 并跨轮次复用（目录名由对话 ID 推导，位于
  `workspaces/<projectId>/conversation-<conversationId>`）。同一对话的轮次串行执行，
  因此复用在并发上安全；复用在授权上也安全，因为当前模式只读且每次执行仍重新校验分支
  快照。命中同一快照时只做一次 `rev-parse` 校验；快照前进时在同一目录内
  `checkout --detach`，不重建目录。常驻工作区按空闲 TTL 与数量上限淘汰，Server
  关闭时统一删除，`storage cleanup` 也会跳过仍有在途轮次的对话。

## Git 快照的懒加载

镜像（`mirrors/<projectId>.git`）是持久复用的对象库。固定提交不可变，因此只要镜像
里已有目标 SHA，就不需要联网刷新远端：`prepareWorkspace` 与
`prepareConversationWorkspace` 先做一次 `cat-file -e`，命中即跳过 fetch；缺失时才按
SHA 定向抓取。需要比较差异基准（`git.ensure_base_sha`）等额外快照时，同样先查本地
再联网。这既保留了「每个任务固定到不可变 SHA」的不变量，也去掉了每次执行一次多余
的远端往返。

## 任务与失败语义

任务生命周期为 `queued -> preparing -> analyzing -> [fixing -> verifying] ->
publishing -> completed`，并可进入 `failed`、`stale` 或 `cancelled` 终态。任务存储
负责校验所有状态转换。

内联事件执行器通过可续期租约领取任务，并在任务运行期间检查调用方的取消请求。发布前中断的
工作可在限定的尝试次数内重试。若租约在发布期间过期，则任务失败且不自动重试，以免
向 GitLab 重复发布评论。执行器必须始终释放 Pi 会话并清理 worktree；清理错误也须
明确报告。

## TypeScript 项目结构

```text
src/
  cli.ts
  config/
  app/                 # HTTP 服务端、内联事件执行器与对话执行器生命周期
  app/http/            # Fastify 路由、鉴权、webhook 与控制台静态资源
  jobs/                # SQLite schema、存储、状态机和指标
  gitlab/              # Webhook 解析、命令和 REST 客户端
  git/                 # 镜像、worktree、差异、路径和补丁操作
  agent/               # Pi 会话工厂、事件和结构化结果解析
  review/
  fix/
  implement/           # Issue 助手 / Draft MR 工作流
test/
  unit/
  integration/
```

HTTP 层使用 Fastify，路由按系统检查、GitLab webhook、运维 API 和控制台静态资源拆分在
`src/app/http`；`CorvexServer` 只保留生命周期、内联事件执行、内联对话轮次与清理任务。选择 Fastify 是因为
它在不引入 ORM 或额外中间件的前提下提供成熟的路由、请求体上限和钩子机制，同时仍允许
webhook 以原始字节读取、SSE 直接写原生响应，从而保留既有的验签、响应头、状态码与日志。
信号、进程管理、SQLite 和文件系统操作继续使用 Node.js 内置能力。外部依赖保持精简，
主要用于 Pi、HTTP 框架、YAML 解析和测试。运行时包管理与锁文件遵循仓库现有的 pnpm 约定；
Node.js 版本由 `engines.node` 和 CI 固定。

## 配置与运维

保留 YAML 配置和现有环境变量名称，涵盖 GitLab Token、Webhook 密钥、模型密钥/基础
URL/名称、监听地址、数据库路径和存储根目录。通过 `init` 生成配置模板，并在启动
Server 前按运行角色校验配置。Server 需要 GitLab 读写令牌和 Webhook 密钥；模型密钥可以
只在运维台配置。示例配置和日志中不得包含密钥。

必须保留以下能力：

- `init`、按角色校验配置、`server`、`backup`、任务列表/安全重试和 Git
  存储清理 CLI 能力。
- `/healthz`、基于数据库状态的 `/readyz` 和 Prometheus `/metrics`。
- Docker Compose 的单 server 服务、非 root 用户、只读容器根文件系统、移除
  不必要的 capabilities、资源限制，以及持久化 SQLite/Git 卷。
- 数据保留策略、SQLite 在线备份/恢复流程，以及 dry-run 优先的 Git 存储清理。
- 通过人工标注样例和显式在线运行的评审基准评估质量；基准运行不属于常规 CI。

运维控制台使用 React 渲染，源码位于 `src/app/ui`，由 Vite 在构建阶段打包到 `dist/app/ui`；
Server 只按 `/ops/assets/<file>` 白名单提供构建产物。控制台包含持久对话工作台，会按
只读 Token 发现目标、固定 SHA 并保存每轮消息；助手回复按 Markdown 渲染并提供复制操作。
Agent 不得修改 worktree 或发布 GitLab 评论。React、React DOM、Vite、antd、`@ant-design/x`
与 `@ant-design/x-markdown` 均被打包进 `dist/app/ui`，属于构建期依赖，不进入运行时依赖。

运行环境必须包含 Git。SQLite 由 Node.js 26.12.1 内置的 `node:sqlite` 模块提供。Docker
构建使用锁定的生产依赖，构建 TypeScript，并在 Node.js 26.12.1 上运行编译后的应用。
版本标签发布会在 CI 检查通过后构建多架构 GHCR 镜像并创建源码 Release。

## 迁移记录

TypeScript 迁移已完成。迁移按小步实施，并以原运行时行为作为参照；当前不保留永久
RPC/sidecar 桥接。

1. **架构契约：** 以本文档记录目标架构，迁移期间保持当前行为和安全不变量。
2. **TypeScript 基础设施：** 固定 Node 和 pnpm 版本、包管理脚本、严格 TypeScript、测试运行器、
   lint、构建和 Pi SDK 依赖。
3. **纯领域模块：** 迁移配置校验、命令解析、模型、验证和状态转换测试。
4. **存储与集成：** 迁移 SQLite schema/存储、GitLab API/Webhook 和 Git 引擎；迁移
   测试并增加基于 fixture 的集成测试。
5. **应用运行时：** 迁移 CLI、HTTP 服务端、内联事件执行器、租约、取消、数据保留、指标
   和备份。
6. **Pi 事件执行器：** 每项任务使用独立 Pi 会话和受控工具/资源，实现结构化输出、Token
   统计，以及与既有行为一致的审查/修复流程。
7. **打包发布：** 迁移 Docker/Compose、CI、发布流程、示例和文档。
8. **切换完成：** 在通过行为一致性检查后，移除被替代的源码、模块文件、CI/发布步骤和
   过时说明。

任何阶段都不得为了简化迁移而削弱授权或安全约束。必须验证数据兼容性：TypeScript
存储层须能无数据丢失地打开既有 SQLite schema；否则，必须在切换前提供经过测试并有
文档说明的备份与迁移方案。

## 完成标准

- TypeScript 实现所有现有命令、Webhook 过滤和授权、队列/状态/重试/取消行为、GitLab
  发布、Git 隔离、审查校验、修复补丁检查、Token 统计、指标、数据保留和备份。
- 测试覆盖既有行为及异常输入、租约过期、取消、MR 版本过期、重复事件、无效模型输出
  和补丁范围违规。
- CI 中 `pnpm install --frozen-lockfile`、lint、typecheck、单元/集成测试和生产构建均通过；Docker server 与
  server 模式均可成功启动。
- 部署与配置文档仅描述 TypeScript/Pi 运行时。
- 生产构建和部署使用单一运行时，不再保留被替代的源码或发布路径。

## Pi 参考资料

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi Agent 循环](https://pi.dev/docs/latest/how-pi-works)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi RPC 与 CLI 集成](https://pi.dev/docs/latest/cli-integration)
- [Pi 安全](https://pi.dev/docs/latest/security)
