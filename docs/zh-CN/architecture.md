# 架构与工作流程

## 组件

Corvex 是单进程应用：一个 Server 同时提供 HTTP 服务和内联对话执行，共用一个 SQLite 数据库与一个 Git 存储根目录。不再支持拆分部署。

1. **Server** 提供运维台 `/ops` 与 API，通过 GitLab OAuth2 认证每个用户，按用户令牌发现可见项目；每次请求读取运行时设置，连接参数变更后立即重建 GitLab 客户端。
2. **SQLite** 是持久化状态存储，记录用户与会话、对话及其消息/轮次、轨迹与执行步骤、过程快照、审计事件、模型调用指标、运行时设置以及可选的每日 Token 预留。
3. **内联对话执行器（`ConversationRunner`）** 运行在 Server 进程内：领取轮次租约、固定仓库分支头 SHA、复用对话专用 worktree、运行一个 Pi SDK 会话、流式转发过程，并持久化轨迹与最终回复。新入队的轮次会立即唤醒它；启动时回收上次进程留下的在途轮次。
4. **GitLab API** 提供 OAuth 登录、项目与分支发现、Issue/MR 读取，并接收对话通过显式写工具发出的写入。
5. **OpenAI 兼容模型 API** 由 Pi Agent 为每一轮对话调用；模型选择按用户支持，个人模型只作用于该用户的对话。

克隆地址与网页地址由配置的 `gitlab.base_url` 加上项目的 `path_with_namespace` 派生，不使用 GitLab 返回的 `http_url_to_repo` / `web_url`：它们由实例的 `external_url` 决定，可能指向 Corvex 无法访问的地址。Git 管理器仍会校验派生地址的协议与主机和配置一致。

GitLab GET 请求遇到瞬时网络错误或 HTTP 408、425、429、500、502、503、504 时，最多尝试三次并使用有界退避；POST 写请求不会自动重试，因为远端副作用可能无法确认。Webhook 事件及其入队/租约/重试机制已延期，详见 [ROADMAP.zh_CN.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.zh_CN.md)。

## 对话轮次流程

1. 用户通过 GitLab OAuth2 登录运维台，选择项目与分支。
2. `POST /api/ops/conversations` 创建对话：服务端解析并固定分支头 SHA，并立即用 `conversationStart` 钩子从首条消息派生标题；首轮结束后 `conversationTitleRefine` 只提交用户消息给模型精炼标题，禁用所有工具，失败则保留原标题。插件可覆盖这两个钩子。
3. `POST /api/ops/conversations/<id>/messages` 排入下一轮（`queued`）。执行器按对话串行处理，每轮领取租约并再次校验固定 SHA；若分支已移动，该轮以 `stale` 结束，不会基于不一致的快照作答。
4. Pi 会话使用窄工具集运行；累计文本、思考过程、工具调用与上下文变化通过 SSE（`text` / `thinking` / `tool` / `context` / `done`）推送给控制台，回答落库后立即关闭流。
5. 执行器把助手正文写入 SQLite，轮次转为 `completed`，并保存轨迹、执行步骤与过程快照；统计接口从成功的 LLM 轨迹派生 TPS、耗时与模型标签。
6. 进程崩溃后重启时，仍在 `queued` / `running` 的在途轮次会被标记为失败，避免悬挂。输入框中的斜杠命令只是本轮模型指令，不创建任何状态。

## 持久对话

对话是运维台的一等对象，使用独立表（`conversations`、`conversation_messages`、`conversation_turns`）存储，轮次由 Server 通过 `ConversationRunner` 内联执行，不进入任何事件队列。每轮拥有按 `turn_id` 关联的轨迹与执行记录；`GET /api/ops/conversations/<id>/turns` 把整段对话合并成一条有序时间线，`GET /api/ops/conversations/<id>/turns/<turnId>` 只读取单轮并校验归属，`GET /api/ops/conversations/<id>/stats` 汇总用量与耗时，`GET /api/ops/conversations/<id>` 还返回服务端派生的系统提示词；`GET /api/ops/conversations/<id>/context` 与 `.../context/<seq>` 提供按请求记录的上下文快照。Pi 的 `context_with_system` 扩展把提示词按系统 / 工具 / 用户 / 注入 / 助手 / 工具结果分类，经 `contextSnapshot` 钩子产出有界快照，默认 tap 将脱敏预览写入 `conversation_context_snapshots`；「上下文」标签展示窗口占用、组成、请求时间线、逐项内容与上下文事件，可用 `agent.context_inspect_enabled` 关闭采集。轨迹数据在 `src/store.ts` 中脱敏并限长。

斜杠命令由管理员维护的技能提供，存放在磁盘的 `<storage.root>/skills/<name>/SKILL.md`，遵循 [Agent Skills 规范](https://agentskills.io/specification)，正文为单语言 Markdown、支持 `$ARGUMENTS`，并可包含许可证、兼容性、元数据与允许工具字段。SQLite 不再保存技能文档或导入的 ZIP 压缩包。`skills-lock.json`（版本 2）记录每个技能的来源、ref/commit 与 npx skills 兼容的内容哈希，`list` / `verify` / 严格导入沿用 npx skills 的 tracked / modified / missing / untracked 语义，并支持从本地 ZIP 恢复。所有写操作由进程内队列加 `.skills.lock` 文件锁串行化，并通过临时文件 + rename 原子替换，避免并发管理请求或多进程写坏锁文件。`resolveCommandRequest` 从内存快照在请求出站前展开模板，命令名不会发给模型；七个旧命令在启动时作为可编辑的系统技能种子写入，CRUD 仅在管理员的 `/api/ops/admin/skills`，普通用户通过 `/api/ops/skills` 读取已启用技能。技能目录里的其它文件按原样保留，可通过 `skill://` 按需读取；SKILL.md 允许放在子目录，按 npm skills 规则递归发现（跳过点目录与 node_modules）。托管技能根同时注册为 Pi 的技能发现路径与 `skill://` 只读根；由于 Corvex 隐藏了 Pi 内置 `read`/`bash`，系统提示词由 Corvex 自行注入 `<available_skills>` 段，只包含名称、描述和虚拟 URI，模型用 `read_file` 按需读取正文。`disable-model-invocation: true` 从模型目录隐藏，`user-invocable: false` 从斜杠菜单隐藏。

工作区铺满视口：左侧对话列表按仓库分组、最近更新的对话与分组优先，组标题吸顶并带稳定色点，运行中的轮次显示脉冲圆点；右侧工作区的 **Chat**、**调用记录**、**轨迹**、**上下文**、**统计**、**变更**、**Git 图谱**、**文件面板** 分别呈现回复与工具调用时间线、按轮次的执行步骤、合并轨迹（可聚焦单轮，LLM / 工具 / 上下文三条轨道）、每次模型请求的上下文组成与内容、用量汇总、按轮次或全会话的改动、项目镜像的提交图与补丁导出、以及固定快照下的文件浏览。仓库名按钮弹出项目信息 Popover（含分支与固定 SHA）；欢迎页提供按意图分组的快捷提示词。

轮次运行期间，Chat 页逐字流式显示助手回复；思考与工具调用排成一条交错时间线（每轮模型调用开始一条思考，随后是该轮的工具调用），并连同中间回复折成脱敏、限长的轮次过程快照写入 SQLite，刷新页面后仍可还原。会话把完整的 Pi Session（含 tool_use/tool_result 消息）持久化到 `conversation_sessions`（4 MiB 上限），下一轮用 `SessionManager.inMemory` 恢复，让模型看到真实历史而不是只看到自己说过的文本；超限时保留最近压缩点与最新连续消息链并记日志，不再整体放弃；模型输出上限没有固定天花板，只要求小于上下文窗口，校验失败会给出具体原因和建议值；思考预算被压到输出预算以下，若模型仍把输出全用于思考而没有正文，则以更低思考等级自动重试一次，而不是直接判本轮失败。长任务自主执行方面：会话内记录有界的工具调用签名，连续重复（4 次）或累计重复（8 次）以及同一工具连续失败（3 次）时会向模型注入换策略提示；`record_plan` 升级为跨轮持久化的任务清单（pending/in_progress/completed），可用 `steps` 重写或用 `updates` 只更新进度，界面按状态渲染。其余缺口见 ROADMAP.md。任务级软预算（`agent.task_max_rounds` / `task_max_output_tokens`）在达到上限时要求模型收尾汇报，不中止轮次；「已修复 / 已完成」也被视为高风险声明，本轮没有 read_file 或 git_diff 回读就会在过程块提示未验证。对升级前创建的会话，仍注入最近 10 轮的有界「操作证据」作为回退；关于「做过什么 / 链接来自哪里」的事实断言必须先用读取工具核实，URL 只能原样取自工具结果。运行中发送消息会由 `SteerChannel` 转交 Pi SDK 的 `session.steer`，在下一次模型调用前送达，不新建轮次、也不改变固定快照；若轮次刚好结束则自动降级为普通的下一轮，SSE 的 `interjection` 事件让控制台立即刷新出这条补充。显式 `delivery: "queue"` 会把消息写入持久 FIFO 队列（`conversation_followups`），当前轮结束后重新解析分支快照并依次执行，可在输入框上方排序或移除；`delivery: "interrupt"` 则中止当前轮、等待已完成改动落库后立刻用新消息开新一轮。输入框在运行期间同时提供插话、排队、打断与停止四个操作。上下文变化作为第三类轨迹记录（`context.compact` / `context.trim`），在 Chat 过程块中给出本地化提示，并在 Trace 的 Context 检查器中展示有界的压缩前后快照。`record_plan` 工具把 3–6 步计划记入过程快照；过程块在运行期间强制展开，结束后作为整体收起。每次模型请求到首个输出之间都会显示带已等待秒数的动态提示：`reset` 文本/思考事件（以及每个工具结束后）重新进入等待，实际内容或工具开始执行时退出，避免多轮工具循环看起来像卡住。等待超过 15 秒后文案与配色升级为安抚提示，超过 60 秒再次升级并明确告知可停止本轮。右侧文件面板默认读取持久工作区，被淘汰时自动回退到 GitLab 文件接口，并标明实际来源；文本使用只读 Monaco 查看器，图片有独立预览器。Git 图谱高亮固定 SHA 与 `refs/conversations/<id>` 提交，支持按作者筛选、展开提交详情、下载可直接 `git apply` 的补丁。

每个对话常驻一个 worktree（`workspaces/<projectId>/conversation-<id>`），跨轮复用：空闲 TTL 与 LRU 上限由运行时设置控制，Server 关闭与启动时都会清理；同一固定 SHA 的追问只重新校验 HEAD，不会重复检出。镜像按需抓取，只有缺失 SHA 时才 fetch。文件改动通过有界的文件工具写入，并由 `saveConversationChanges` 提交到镜像的会话 ref，因此工作区被清理后仍会恢复。淘汰与清理从不触碰有排队或运行中轮次的对话。单个会话的资源清理（Git ref / worktree、缓存的流状态及插件自有资源）统一走 `conversationDelete` 钩子：两个删除路由与保留任务都会带上会话 ID、项目 ID 和轮次 ID 触发它，默认 tap 先释放 Git 资源再清理流状态，所有 tap 成功后才会删除数据库记录。`AppStore.pruneHistory` 会返回被裁剪的会话列表，使保留任务能逐会话触发钩子，而不只是事后扫描孤儿 ref。

### 上下文预算

Corvex 让对话始终落在模型上下文窗口之内，而不是等服务商拒绝请求。请求离开进程前，`src/agent/budget.ts` 用保守估算（取 chars/4 与 UTF-8 字节数/3 的较大值，避免中文与压缩代码被低估），`trimHistory` 只保留符合 `agent.history_token_budget` 且不超过 `agent.max_input_tokens` 剩余额度的最近历史；被裁掉的历史压缩成持久化的滚动摘要供后续轮次复用，摘要按预算分块进行。请求本身以结构化多消息构建，而非拼成一个大字符串。

单轮内，工具结果在进入会话历史前被确定性截断：`src/agent/tool-budget.ts` 为 128K 窗口限制单次约 32 KiB、每个助手轮次约 64 KiB，并在截断处留下标记提示模型改用更精确的路径或行范围。这个硬上限是必要的：SDK 以最后一次服务商真实用量为锚点，只能估算此后新增的内容。`agent.turn_tool_result_bytes` 仍是软检查点，提示模型记录进展并改用聚焦读取；运行时把它收敛到四个工具输出轮次，确保在压缩之前触发。上下文增长由 SDK 压缩吸收，压缩预留覆盖单轮工具输出的最坏 Token 增量加 `max_output_tokens`。旧工具结果的微压缩只在估算请求接近压缩阈值前 15 个百分点时触发，保留窗口随模型上下文窗口缩放，并按稳定的工具调用标识只上报新进入裁剪集合的结果；`read_file` 在同一会话内重复读同一路径 5 次后给出提示，控制台把同类上下文提示合并成一条并带重复次数。若服务商仍报超窗，`isContextOverflowError` 识别后会再去掉全部历史激进重试一次；开启 `agent.auto_context_tune` 时，还会在本次会话的重试中使用更小的有效上下文窗口，不会修改已保存的模型配置。这些键以及模型、回复语言与工具开关都可以在运维台设置页面运行时调整，Server 用与配置文件相同的定义校验，写入审计并在启动时重新应用；界面展示的生效值会标明被安全下限调整过的字段。

## 工具与写入边界

Pi 会话不开放内建 shell、edit 或 write 工具；命令执行仅在开启执行环境后由绑定的 `run_command` 工具提供，工具集由对话模式（`ConversationMode`，当前只有 `gitlab`）派生，读写能力统一。

- **文件读取**通过 `read_file` / `read_dir` / `stat` / `search_text` / `git_grep` 完成，只读取固定 SHA worktree 或可信 Skill 根目录中的 UTF-8 文本；仓库文件必须使用相对路径，绝对路径只接受 Skill 根目录。文件改动通过 `write_file` / `edit_file` / `delete_file` / `move_file` / `copy_file` 完成，并受统一的 worktree 路径守卫与字节上限约束。
- **Git 工具**限定在对话 worktree 与本地镜像：`git_status`、`git_log`、`git_show`、`git_diff`、`git_branches`、`git_clone`、`git_branch`、`git_checkout`、`git_pull`、`git_merge`、`git_commit`、`git_push`、`git_revert`。不接受任意 URL、远端或强制推送；`git_push` 只写镜像中的 `refs/conversations/<id>`，绝不写 GitLab 分支。分支、合并与回滚都经过校验，不会重写历史。
- **GitLab 工具**固定绑定到对话项目：项目与 MR 发现、Issue/MR 读取、讨论与变更，以及 Issue/MR 的创建、更新、关闭、评论等生命周期操作。iid 必须来自用户或读取结果；写操作需要用户明确意图，删除、合并、批准等不可逆或公开动作在描述中明确标注。
- `web_fetch`（启用时）只能访问公网 HTTPS 主机，重定向会重新校验，私网/保留地址与配置的黑名单主机始终被拒绝，返回文本受限且视为不可信输入。`web_search` 使用 Tavily 免费免 key 模式：查询文本会发送给 Tavily，共享额度可能限流，限流时以提示文本返回而不是让本轮失败；结果链接经过与 `web_fetch` 相同的 URL 校验，摘要限长，每轮搜索次数可配置。搜索结果是第三方不可信文本。Skill 只是指令，不是访问控制。
- 命令仅在开启执行环境后经绑定到会话 worktree 的 `run_command` 工具执行，不存在任意 shell。技能可在 `corvex-commands` 元数据中声明固定命令并用 `corvex-commands-enabled` 开启，模型只能通过 `run_skill_command` 调用，命令字符串来自技能文档、不插值用户输入，执行仍沿用配置的后端、上限、脱敏与审计；技能目录里的其它文件不会被自动执行。Agent 输出不被信任，GitLab 写入前再次校验授权、取消状态与固定版本。

## 轮次状态与取消

主要状态流程为 `queued -> running -> completed`，此外还有 `failed`、`stale` 和 `cancelled`。同一对话的轮次串行执行；运行或排队期间，输入框的发送按钮变为 **Stop**，通过 `POST /api/ops/conversations/<id>/turns/<turnId>/cancel` 请求取消，本地挂起状态随即清除。删除对话在轮次运行时会被拒绝。模型请求失败、超窗或工具越界会记录错误；失败不会自动重试，因为 GitLab 写入结果可能不确定——需要重做时重新发送消息，创建一个新轮次。Webhook 事件的状态机、租约与重试已延期，见 [ROADMAP.zh_CN.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.zh_CN.md)。

## 持久化和数据保留

SQLite 使用 WAL 模式、单一打开连接和 5 秒忙碌超时；数据库必须放在持久且可写的存储中，建议使用支持 SQLite 锁定的本地文件系统或卷。每日清理按 `storage.retention_days` 删除已结束的轮次、轨迹、执行步骤与每日 Token 用量，按 `storage.audit_retention_days` 清理审计记录；排队和运行中的轮次会被保留。空闲对话超过保留期时连同消息一并删除，仍有排队或运行中轮次的对话不会被丢弃。Git 镜像与 worktree 位于 `storage.root` 下，不由数据库清理管理；清理记录写入 `storage_cleanup_log`，孤儿会话 ref 与不可达对象由 ref 清理和镜像 GC 回收。

## 安全边界和限制

- 用户在运维台通过 GitLab OAuth2 登录，控制台 API 与对话使用该用户自己的令牌；项目范围由令牌可见性决定，不是静态白名单。
- OAuth 凭据、读/写令牌与模型 API Key 保存在 SQLite 运行时设置中，接口不回显，留空表示保留原值；请保护数据库及备份。
- 仓库内容、评论、文件名和网页内容都是不可信模型输入；模型输出会经过校验，但校验不能替代人工审阅。所有 GitLab 写入都需要明确的用户意图。
- 每轮固定分支头 SHA，并在准备工作区和 GitLab 写入前复核；快照过期以 `stale` 结束，而不是部分写入。
- 不运行不可信仓库代码，没有测试执行器，也不会自动把改动应用到 GitLab 分支；push 仅写会话 ref。
- HTTP 服务只提供认证、运维台、健康检查与指标接口，没有 Webhook 接收端点；Webhook 驱动的事件目前是延期特性，见 [ROADMAP.zh_CN.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.zh_CN.md)。
