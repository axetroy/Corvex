# Corvex 架构设计

## 架构决策与状态

**目标架构与当前实现：单一 TypeScript 应用，以 Pi TypeScript SDK 作为 Agent 运行时。**
在不保留已替换运行时遗留物的前提下，维持现有用户可见行为和安全边界。

Corvex 是一个可自行部署的 GitLab 合并请求（MR）审查与修复建议助手。用户在
GitLab MR 评论中提及 `@corvex`，并发送 `review`、`explain <path>`、`fix`、
`status` 或 `cancel` 命令。系统会验证请求身份和权限，将请求持久化，针对确切的
MR 版本进行分析，校验分析结果，并将结果发布回 GitLab。

## 目标与非目标

### 目标

- 使用 Pi 处理 Agent 循环、模型和会话生命周期、自定义工具、Skills，以及可选的
  MCP 集成；不重复实现这些运行时能力。
- 将产品作为单一 Node.js 应用部署，通过 `server` 和 `worker` 两种进程模式运行，
  并共享 SQLite 数据库和 Git 存储。
- 保留持久化任务、Webhook 幂等性、租约、取消、重试策略、审计、Token 用量统计和
  可观测性。
- 将每项任务固定到 MR 的准确 base/head SHA，并在独立的 detached Git worktree 中
  执行。
- 将权限控制、结果校验、补丁范围检查和发布决策保留在可信的 Corvex 代码中，不交由
  Agent 决定。
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
TypeScript 服务端
  - 验证 Webhook 令牌和事件
  - 过滤机器人及系统评论
  - 校验项目和用户白名单
  - 解析命令并创建幂等任务
  - 提供健康检查、就绪检查、指标和数据保留
       |
       v
SQLite 任务存储 <----- TypeScript Worker
                         - 领取租约、心跳、处理取消和重试
                         - 获取当前 MR 信息和固定版本的差异
                         - 准备隔离的 detached worktree
                         - 使用任务专属工具调用 Pi SDK
                         - 校验输出并重新确认 MR 版本
                         - 在授权后应用并检查受限补丁
                         - 通过 GitLab API 发布发现和摘要
```

服务端和 Worker 是同一个 TypeScript 入口的两种运行模式，而非两个独立服务。为加强
隔离，可以将它们运行在不同进程或容器中，但仍须使用同一个本地 SQLite 数据库和存储
卷。不得在网络文件系统上跨主机共享 SQLite 数据库。

### 职责边界

| 领域 | 负责方 |
|---|---|
| Webhook 验证、命令解析、白名单和修复授权 | Corvex 策略代码 |
| 持久化任务、幂等性、租约、状态转换、重试和取消 | Corvex SQLite 存储与 Worker |
| GitLab API 访问和评论发布 | Corvex GitLab 客户端 |
| 镜像、固定 SHA 的 worktree、受限差异和安全文件访问 | Corvex Git 引擎 |
| Agent 循环、模型提供方、会话和上下文生命周期 | Pi SDK |
| Skills、自定义 Agent 工具和可选 MCP 集成 | Pi 资源/扩展，由 Corvex 显式配置 |
| 发现项/补丁校验、版本复核和发布决策 | Corvex 策略代码 |

Pi 是执行依赖，不是业务状态的权威来源。Pi 会话用于 Agent 上下文和诊断；任务状态、
重试、审计、取消和发布状态均以 SQLite 任务记录为准。除非产品明确需要恢复会话，
否则优先为每项任务创建一次性会话。

## Pi 集成与能力

Worker 通过 TypeScript SDK 使用 `@earendil-works/pi-coding-agent`。每项任务单独创建
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

Pi 工具和扩展以 Worker 的操作系统权限运行。Worker 应使用专用低权限用户，仅挂载所需
的 worktree 和数据，使用权限范围受限的凭证，并配置容器及网络限制。提示注入防护有
帮助，但不能视作安全边界。

## 安全不变量

1. 以恒定时间比较 Webhook 密钥，并限制请求体大小。
2. 项目或用户白名单为空时配置无效，绝不表示允许所有对象。
3. 机器人和系统评论不得创建任务；重复的 Webhook 事件必须保持幂等。
4. `fix` 请求必须同时满足独立的修复白名单和修复模式已启用。
5. 任务记录完整的 MR Head SHA；获取差异、准备 worktree 和发布时均须验证预期快照。
6. 仓库路径必须规范化并限制在任务 worktree 内；在适用场景下拒绝符号链接、超大文件、
   二进制文件和范围外路径。
7. Agent 输出一律视为不可信。发现项必须精确引用新增行。修复补丁仅限变更路径、受大小
   限制，并通过 `git apply --check` 和 `git diff --check` 检查。
8. Agent 不得直接发布。发布前由 Corvex 重新检查授权、任务取消状态和 MR 版本，并使用
   仅具备写入所需权限的 Token。
9. 外部发布结果不确定时不得盲目重试。
10. 不执行仓库命令或脚本。若要增加执行器，必须单独设计沙箱和显式授权模型。

## 任务与失败语义

任务生命周期为 `queued -> preparing -> analyzing -> [fixing -> verifying] ->
publishing -> completed`，并可进入 `failed`、`stale` 或 `cancelled` 终态。任务存储
负责校验所有状态转换。

Worker 通过可续期租约领取任务，并在任务运行期间检查调用方的取消请求。发布前中断的
工作可在限定的尝试次数内重试。若租约在发布期间过期，则任务失败且不自动重试，以免
向 GitLab 重复发布评论。Worker 必须始终释放 Pi 会话并清理 worktree；清理错误也须
明确报告。

## TypeScript 项目结构

```text
src/
  cli.ts
  config/
  app/                 # HTTP 服务端与 Worker 生命周期
  jobs/                # SQLite schema、存储、状态机和指标
  gitlab/              # Webhook 解析、命令和 REST 客户端
  git/                 # 镜像、worktree、差异、路径和补丁操作
  agent/               # Pi 会话工厂、事件和结构化结果解析
  review/
  fix/
  policy/
  observability/
test/
  unit/
  integration/
```

HTTP、信号、进程管理和文件系统操作优先使用 Node.js 内置能力。外部依赖保持精简，
主要用于 Pi、YAML 解析和测试。运行时包管理与锁文件遵循仓库现有的 npm 约定；Node.js
版本由 `engines.node` 和 CI 固定。

## 配置与运维

保留 YAML 配置和现有环境变量名称，涵盖 GitLab Token、Webhook 密钥、模型密钥/基础
URL/名称、监听地址、数据库路径和存储根目录。在启动监听器或 Worker 前完成配置校验。
示例配置和日志中不得包含密钥。

必须保留以下能力：

- `server`、`worker` 和 `backup` CLI 模式。
- `/healthz`、基于数据库状态的 `/readyz` 和 Prometheus `/metrics`。
- Docker Compose 的 server/worker profiles、非 root 用户、只读容器根文件系统、移除
  不必要的 capabilities、资源限制，以及持久化 SQLite/Git 卷。
- 数据保留策略，以及 SQLite 在线备份和恢复流程。

运行环境必须包含 Git。SQLite 由 Node.js 26.12.1 内置的 `node:sqlite` 模块提供。Docker
构建使用锁定的生产依赖，构建 TypeScript，并在 Node.js 26.12.1 上运行编译后的应用。

## 迁移记录

TypeScript 迁移已完成。迁移按小步实施，并以原运行时行为作为参照；当前不保留永久
RPC/sidecar 桥接。

1. **架构契约：** 以本文档记录目标架构，迁移期间保持当前行为和安全不变量。
2. **TypeScript 基础设施：** 固定 Node 版本、npm 脚本、严格 TypeScript、测试运行器、
   lint、构建和 Pi SDK 依赖。
3. **纯领域模块：** 迁移配置校验、命令解析、模型、验证和状态转换测试。
4. **存储与集成：** 迁移 SQLite schema/存储、GitLab API/Webhook 和 Git 引擎；迁移
   测试并增加基于 fixture 的集成测试。
5. **应用运行时：** 迁移 CLI、HTTP 服务端、后台 Worker、租约、取消、数据保留、指标
   和备份。
6. **Pi Worker：** 每项任务使用独立 Pi 会话和受控工具/资源，实现结构化输出、Token
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
- CI 中 `npm ci`、lint、typecheck、单元/集成测试和生产构建均通过；Docker server 与
  worker 模式均可成功启动。
- 部署与配置文档仅描述 TypeScript/Pi 运行时。
- 生产构建和部署使用单一运行时，不再保留被替代的源码或发布路径。

## Pi 参考资料

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi Agent 循环](https://pi.dev/docs/latest/how-pi-works)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi RPC 与 CLI 集成](https://pi.dev/docs/latest/cli-integration)
- [Pi 安全](https://pi.dev/docs/latest/security)
