# 执行环境设计（自由命令 + 沙箱）

本文是 `design.md` 中「执行器需单独设计沙箱与显式授权模型」这一约束的具体落地方案。它定义 Corvex 如何在保持单一控制进程的前提下，让 Agent 运行自由命令，并通过双后端（本地 / 沙箱）隔离执行。本文是架构契约，任何实现都不得削弱这里的安全边界。

## 1. 背景与目标

主流编码 Agent 的核心闭环是「修改 → 运行检查 → 读取失败 → 再修改」。Corvex 此前没有执行器：只能读代码、改文件、操作 Git，但**无法真正验证改动**（类型检查、lint、测试都跑不了）。这使长任务只能靠模型"自述"完成，无法形成真正的验证闭环。

本设计的目标：

- 让 Agent 能在绑定会话的 worktree 里运行**自由命令**（`tsc --noEmit`、`npm test`、`git diff` 等任意命令）；
- 提供**本地后端**（开发便捷）与**沙箱后端**（生产隔离）两种执行环境，按配置选择；
- 把授权、隔离、审计、结果回灌全部留在可信的 Corvex 代码里，不交给模型或提示词。

## 2. 非目标与红线

- **不是通用 shell 服务**：Agent 通过工具提交命令，Corvex 解析并受控执行；工具不提供交互式终端、不常驻进程。
- **不引入第二套控制平面**：沙箱容器只是被 Corvex spawn 的子进程，不引入 sidecar 服务或远程执行 API；Corvex 仍是唯一控制进程。
- **授权在代码里**：模型输出、仓库内容、Skill 指令都不能扩大权限；能否执行、在哪执行、执行多久由配置与应用代码决定。
- **沙箱不是绝对安全边界**：容器逃逸、供应链（执行的 `node_modules` 来自仓库）仍是残余风险，文档会如实标注，不宣称"安全运行任意不可信代码"。

## 3. 工具接口

新增工具 `run_command`：

```
run_command({
  command: string,        // 自由命令字符串
  reason?: string,        // 模型给出的执行理由（展示与审计用）
  timeoutMs?: number,     // 可选，受配置上限约束，不能超过配置值
  maxOutputBytes?: number // 可选，同上
})
```

关键规则：

1. **命令由 shell 解释，隔离由后端提供**：自由命令用 `spawn(command, { shell: true })` 执行，支持管道、重定向、`&&` 等常规语法。安全边界不是"禁用 shell 元字符"，而是**沙箱后端**（生产强制）。此前设想的 argv-only 方案会破坏合法命令（箭头函数 `=>`、带引号的 JS 表达式），也不支持 `npm test | tail`，已废弃。
   - 本地后端同样由 shell 解释，但它仅限开发、明确标注不安全，生产 fail-closed。
2. **参数上限**：`command` 长度、可覆盖的 `timeoutMs` / `maxOutputBytes` 都有硬上限，超过即拒绝。
3. **工作目录固定**：始终是会话的 pinned worktree，不接受路径参数越界。
4. **结果回灌**：`{ command, exitCode, stdout, stderr, truncated, durationMs, backend }` 经 `src/redact.ts` 脱敏、限长后写入 `conversation_trace` 与过程快照。

## 4. 双后端

抽象 `ExecutionBackend` 接口，工厂按配置选择后端：

```
interface ExecutionBackend {
  run(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
```

### 4.1 本地后端（`local`）

- 仅用于本地开发。直接在宿主机 `spawn` 到 worktree。
- **env 白名单**：复用 `buildGitEnvironment` 的净化思路——剥离 `GIT_*` 注入、askpass、代理、令牌类变量，只保留必要项（`PATH`、`HOME=<临时目录>`、`CI=1`、`NODE_ENV` 等）。
- 超时、stdout/stderr 字节上限、进程组 kill。
- **明确标注不安全**：仓库代码能接触宿主机网络与文件。生产禁用（见 §5 fail-closed）。

### 4.2 沙箱后端（`sandbox`）

- 通过容器运行时（docker / podman）执行，检测可用性。
- 隔离参数：非 root、容器网络命名空间与宿主隔离（默认 bridge，**允许联网**以便安装依赖）、只读 rootfs、只挂载 worktree（rw）、`--cap-drop=ALL`、CPU / 内存 / pids 限额、超时 kill。需要完全禁网时显式配置 `network: none`。
- 注意：bridge 网络下容器可通过网关访问宿主发布的服务；若要严格禁止访问宿主，需额外防火墙规则或 `network: none`，但后者会阻断依赖安装，按需取舍。
- 镜像由配置指定（`execution.sandbox.image`，默认 `corvex-exec:latest`，由 `Dockerfile.exec` 构建）：包含 **git、node、npm/npx、经典版 yarn 1.22.22、pnpm 12.23.0、python3、bash、make/g++**，以及常用 Linux 工具 **curl、wget、zip/unzip、xz、jq、file、rsync**（其余 sed/awk/grep/find/tar/gzip/nc/ping 等由 busybox 提供；Node 25+ 不再自带 corepack，故 yarn/pnpm 用 `npm install -g` 显式安装，并在 `USER node` 之前以 root 完成）。不含 bun，需要时用 `npx`。依赖通过挂载 worktree 的 `node_modules` 带入；各包管理器缓存落在容器 tmpfs（`HOME=/tmp` 及各 `*_CACHE` 变量），不污染宿主 worktree。
- 生产强制：容器运行时不可用时**直接拒绝执行**，不得静默回退到本地后端。

### 4.3 后端选择

- 由配置 `execution.backend` 决定，启动期解析，不随会话变化。
- 生产环境（非开发模式）设为 `local` → `validateConfig` 直接失败。

## 5. 配置

执行环境是**安全边界配置**——只有管理员能改，且保存前必须走完整 `validateConfig`（含 fail-closed），不进通用运行时设置（避免普通用户或半套配置绕过隔离）。配置有两个来源，优先级从高到低：

1. **管理中心 UI**（管理员专属）：`GET/PUT /api/ops/admin/execution`，存 SQLite `execution_config` 表，保存即生效（后端在每轮 `runSession` 时从配置重建）。适用于日常调整开关、后端、镜像、限额。
2. **YAML / 环境变量**（文件兜底）：提供初始值，作为 SQLite 无覆盖项时的回退，也是容器化部署的引导入口。改 YAML 需重启。

无论从哪个入口保存，都必须通过同一套校验：生产禁 `local`、sandbox 必须有 image/socket、限额在合理区间。任何校验失败都拒绝写入。

`tmpfs_size_mb` 必须与 `max_output_bytes` 解耦：后者只是输出捕获上限（默认 256 KiB），若用它推导 `/tmp` 容量，npm/yarn/pip 的缓存写入会立刻 ENOSPC。容器内 `HOME=/tmp`，并把 `XDG_CACHE_HOME`、`npm_config_cache`、`YARN_CACHE_FOLDER`、`PIP_CACHE_DIR` 都指向 `/tmp/corvex-cache`，所有临时文件留在容器 tmpfs，既不污染宿主 worktree，也不携带宿主路径。

**可见性边界**：容器只通过 bind mount 看到 `request.cwd` 这一个 worktree 目录；`df` 在该挂载点上显示的是底层文件系统容量（Linux bind mount 的 `statvfs` 语义），这不代表容器能读取宿主其它路径。rootfs 只读、不挂载 docker socket、不注入宿主环境变量或凭据。

`max_output_bytes` 只控制 Corvex **捕获**多少字节返回给模型和终端；Docker 仍把命令的完整 stdout/stderr 写进宿主上的容器日志文件，一个无限打印的命令（如 `yes`）能撑爆 `/var/lib/docker/containers/*-json.log`。因此容器固定使用 `--log-driver json-file` 并加上 `--log-opt max-size=<log_max_size_mb>m` / `--log-opt max-file=<log_max_file>`，在日志写入侧做轮转硬限，与输出捕获预算相互独立。

```yaml
execution:
  # 总开关，默认 false；关闭时模型看不到 run_command 工具
  enabled: true
  # 后端：sandbox（生产）| local（仅开发）
  backend: sandbox
  sandbox:
    runtime: docker            # docker | podman
    image: "corvex-exec:latest"
    socket: "/var/run/docker.sock"
    memory: "2g"
    cpus: 1
    pids_limit: 256
    tmpfs_size_mb: 512         # /tmp 与包管理器缓存的 tmpfs 大小（16–4096），与 max_output_bytes 无关
    log_max_size_mb: 4         # Docker json-file 日志单文件上限（1–1024）
    log_max_file: 2            # 保留的日志文件个数（1–100）
    network: bridge            # bridge（默认，允许联网装依赖）| none（完全禁网）
    read_only_mounts: []
    timeout: 600s
    max_output_bytes: 262144
  local:
    allow_unsafe: true         # 显式确认"知道不安全"
    timeout: 600s
    max_output_bytes: 262144
```

环境变量覆盖（与现有 `CORVEX_STORAGE_ROOT` 风格一致）：

```
CORVEX_EXECUTION_ENABLED=true
CORVEX_EXECUTION_BACKEND=sandbox
CORVEX_EXECUTION_SANDBOX_SOCKET=/var/run/docker.sock
```

校验规则：

- `enabled: false` 时其余字段忽略；
- `backend: sandbox` 时 `sandbox.image` / `sandbox.socket` / `sandbox.runtime` 必填；
- 非开发模式 `backend: local` → 启动失败（fail-closed）；
- 超时、输出上限、资源限额必须为正且在合理区间。

## 6. 授权与审计

- **授权模型**：用户请求即授权本轮执行命令（与现有 Git 写工具一致）；但"执行什么、在哪执行、执行多久"由配置决定，模型只能提交命令字符串。
- **审计**：每次执行写 `audit_events`：`actor / conversationId / turnId / command 前 N 字符 / backend / exitCode / durationMs`。不记录完整命令中的敏感值；输出经脱敏后才入轨迹。
- **取消**：轮次中断信号透传到执行子进程；超时与取消都会 kill 整个进程组。
- **提示词约束**：明确告知模型命令只在沙箱内运行、不要尝试逃逸或访问宿主凭据；这是行为引导，不是权限边界。

## 7. 与完成判定的联动

`src/agent/claim-verification.ts` 已把「已修复 / 已完成」列为高风险声明，要求本轮有回读工具（`read_file` / `git_diff`）。执行器落地后进一步要求：涉及"验证通过 / 测试通过 / 类型检查通过"的声明，必须有 `run_command` 的成功结果支撑，否则在过程块提示未验证。

## 8. 残余风险

- 容器逃逸：内核漏洞或配置失误可能让沙箱内进程触及宿主。
- 供应链：执行的 `node_modules`、构建脚本来自仓库，本身是不可信代码；沙箱限制其影响面，但不保证其无害。
- 本地后端：仓库代码可接触宿主机，仅限可信仓库 + 本地开发。
- 资源耗尽：即使有超时与限额，编译仍可能占满 CPU；用 cgroup 限额 + 进程组 kill 缓解。

这些风险接受为前提：执行目标是**可信工具链执行不可信仓库源码**，而非"安全运行任意不可信代码"。

## 9. 分阶段落地

| 阶段 | 内容 | 提交粒度 |
|---|---|---|
| P0 设计 | 本文 + ROADMAP + `design.md` 引用 | 一次提交 |
| P1 核心 | 配置 schema 与校验、`ExecutionBackend` 接口、本地后端、`run_command` 工具、审计、轨迹、redact；默认关闭 | 一次提交 |
| P2 沙箱 | 容器后端、运行时检测、fail-closed、CI 用 docker-smoke 验证 | 一次提交 |
| P3 体验 | 运维台展示执行结果、完成判定联动、可选缓存 | 一次提交 |

## 10. 测试策略

- 本地后端：用无害命令（`echo`、`node -e`）做 hermetic 测试；验证 shell 语法（`&&`、管道）、env 净化、超时、输出上限、取消、路径固定。
- 沙箱后端：无容器运行时时自动跳过（独立 docker-smoke job），验证隔离参数、禁网、资源限额。
- 跨平台：Windows 路径与进程组 kill 需专门验证（CI 三平台矩阵）。
- 工具层：验证 shell 元字符不被解释、`command` 长度上限、参数上限、结果脱敏。

## 11. 与其他设计的关系

- `design.md`：本文是其"执行器需单独设计沙箱与授权"约束的展开；不改变单进程控制平面与窄工具集原则（`run_command` 是受控工具，不是开放 shell）。
- `ROADMAP.md`：记录本设计的实施状态。
- `AGENTS.md`：记录实现指针，便于后续维护者找到本文。
