# 快速开始

Corvex 是面向 GitLab 的自托管代码协作代理，唯一运行模式是 `server`（单进程：HTTP 服务 + 内联对话执行）：

- **Server** 提供运维台与 API，通过 GitLab OAuth2 认证每个用户，发现该用户可见的项目，并在进程内通过 `ConversationRunner` 执行每一轮对话。
- **内联对话执行器** 领取轮次、固定仓库分支头 SHA、复用对话专用的 detached worktree、运行一个 Pi SDK 会话，流式返回过程并持久化轨迹与最终回复。

Webhook 驱动的事件（审查 / 聊天 / 解释 / 修复 / Issue 实现）目前是延期特性，详见 [ROADMAP.zh_CN.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.zh_CN.md)。对话是运维台里唯一的一等对象。详细内容请参阅[架构与工作流程](./architecture)、[配置参考](./configuration)和[运行环境与运维](./operations)。

## 环境要求

- 从源码运行需要 Node.js 26.12.1 和 pnpm 12.4.1；使用 `pnpm install --frozen-lockfile` 按锁文件安装依赖。
- Server 需要出站访问 GitLab API（OAuth、项目与分支发现、仓库抓取）和模型 API；用户浏览器需要能访问 `/ops`。不需要入站 Webhook 地址。
- Server 主机需要 `git` 可执行程序；项目提供的 Docker 镜像已安装 Git。
- 需要一个 OpenAI 兼容的 Chat Completions 接口及 API Key；Agent Runtime 由 Pi SDK 提供。
- SQLite 数据库和 Git 镜像目录必须位于重启后仍保留且可写的存储中。
- 用户在 GitLab 中需要一个 OAuth Application（用于运维台登录）；项目可见范围由登录用户自己的 GitLab 令牌决定。

## 1. 准备配置和密钥

构建 CLI 并初始化配置模板：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

复制 `configs/config.example.yaml` 为 `configs/config.yaml`。配置文件只需填写启动必需项（监听地址、存储路径）；GitLab 地址、OAuth 凭据和模型都在安装页或运维台设置页写入 SQLite。不再需要共享 GitLab 读/写令牌：所有 GitLab 操作都使用当前登录用户的 OAuth 令牌。可选的环境变量兜底：

```sh
# 可选启动兜底；设置页保存的值优先。
# CORVEX_GITLAB_BASE_URL=https://gitlab.example.com
# CORVEX_MODEL_BASE_URL=https://api.openai.com/v1
# CORVEX_MODEL_NAME=your-model-name
```

启动时不需要 GitLab PAT 或模型 API Key，两者都可在控制台保存。所有 GitLab 访问都使用当前登录用户的 OAuth 令牌，因此权限就是该用户在 GitLab 上的权限。所有配置项及边界值请参阅[配置参考](./configuration)。

## 2. 启动 Server

```sh
pnpm start -- --config configs/config.yaml check-config
pnpm start -- --config configs/config.yaml server
```

默认监听 `0.0.0.0:8080`。对公网提供服务时应通过 HTTPS 暴露，并使用适当的网络访问控制；不要将服务直接暴露给不可信网络。

## 3. 配置 GitLab OAuth 与登录

首次访问 `/ops` 会跳转到 `/setup` 安装页。在此填写 GitLab 实例地址，以及 OAuth Application 的 Application ID、Secret 和回调地址（例如 `https://corvex.example.com/auth/gitlab/callback`，需与 GitLab 应用中登记的一致）。这些值保存在 SQLite，可在「设置 → GitLab 配置」中修改；不需要环境变量。用户令牌的加密密钥在首次启动时生成并保存在数据库中。

每个用户使用自己的 GitLab 账号登录；运维台只展示该用户令牌可见的项目，没有静态项目白名单。系统级的 GitLab 地址与读/写令牌可在管理后台的设置页配置，作为 OAuth 登录之外的连接兜底。

## 4. 发起第一场对话

登录运维台后新建对话：先用带搜索的仓库选择器挑选项目，再选择分支。Corvex 在服务端解析并固定该分支的头 SHA，这一固定快照贯穿整场对话；每轮消息与回复保存在 SQLite，同一对话一次只运行一轮。

工作区铺满视口，左侧为对话列表（按仓库分组、显示轮次数与最近一轮状态），右侧包含六个页签：

| 页签 | 内容 |
|---|---|
| **Chat** | Markdown 回复记录，逐字流式显示；思考与工具调用按执行顺序排成一条时间线；展示系统提示词，并给出复制按钮、生成 TPS、耗时与模型标签。 |
| **调用记录** | 按轮次展示执行步骤与生命周期变化。 |
| **轨迹** | 默认把全部轮次合并成一条带标尺的时间线，也可聚焦单轮；LLM、工具与上下文三条轨道可分别查看，支持缩放与框选。 |
| **上下文** | 按模型请求检查上下文：窗口占用、系统/工具/用户/注入/助手/工具结果的组成条、请求时间线、逐项脱敏预览与上下文事件；选中某次请求后各区块同步更新。可在「设置 → 预算」中关闭采集。 |
| **统计** | 汇总用量与耗时，并给出逐轮明细。 |
| **变更** | 查看会话 ref 的逐文件差异，可按轮次筛选，并在内联 Monaco diff 中审阅。 |
| **Git 图谱** | 只读查看项目镜像的提交图，高亮固定 SHA 与会话 ref 的提交，展开提交详情并下载补丁。 |
| **文件面板** | 浏览固定快照下的文件，文本使用只读代码查看器，图片可直接预览；会标明实际提供数据的来源（本地工作区或 GitLab）。 |

聊天输入框的斜杠命令来自管理员在「设置 → 技能」中配置的对话技能，遵循 [Agent Skills 规范](https://agentskills.io/specification)：名称、描述与 Markdown 提示词模板，可用 `$ARGUMENTS` 占位。输入 `/` 会在可滚动列表中展示已启用的技能。命令名在发送前会被技能模板替换，因此单独发送 `/docs` 也会带上完整指令；这些只是**本轮的模型指令**，不会创建事件、改变状态或向 GitLab 发布内容。技能目录按原样保存在磁盘，附带文件可通过 `skill://` 按需读取；`SKILL.md` 可以放在子目录，会被递归发现。模型会看到一份精简的 `<available_skills>` 目录（名称、描述与虚拟位置），任务匹配时用 `read_file` 按需读取正文；`disable-model-invocation: true` 会把它从模型目录隐藏，`user-invocable: false` 会把它从 `/` 菜单隐藏。「技能」设置页还有**个人技能**分区，只有你自己可见可改；与全局同名时全局优先，你的技能用 `me:<name>`（即 `/me:<name>`）调用。 管理员还可以在「设置 → 技能 → 导入技能包」中导入技能包：上传 ZIP（最大 10 MiB），或填写 GitHub 仓库、GitLab 项目（使用当前登录令牌）以及 HTTPS ZIP 直链。ZIP 与解压后的文件都写到 `<storage.root>/skills/`，来源与内容哈希写入 `skills-lock.json`，可从本地 ZIP 校验恢复；停用或删除技能包会同步停用或删除这些技能。输入框下方显示一条紧凑的上下文简讯，给出最近一次请求的窗口占用与 token 数，点击可打开「上下文」标签。

如果分支在入队消息开始执行前发生移动，该轮会以 `stale` 结束；重新发送消息即可使用当前版本。每个用户还有自己的**设置**页（`#/settings`），可在共享的系统级模型供应商（标有「系统」且只读）之外添加私有供应商与模型；Personal 设置中激活的模型只作用于该用户自己的对话。

## 5. 配置模型

在管理后台的「设置 → 模型」中管理模型供应商：每个供应商保存名称、Base URL 与 API Key，并在其下维护各自的模型（上下文窗口与最大输出 Token）。全局只有一个模型处于使用状态，第一个新增的模型自动激活，切换后无需重启即作用于下一轮。API Key 不会通过接口回显；密码框留空表示沿用已保存的值。模型目录为空时，才使用配置文件或环境变量中的兜底连接参数。

## 工具与写入边界

Pi 会话不开放内建 shell、edit 或 write 工具。仓库文件读取通过有界的 `read_file` / `read_dir` / `tree` / `glob` / `stat` / `search_text` / `git_grep` 完成，仓库路径必须使用相对路径（只有可信 Skill 根目录允许绝对路径）。Skill 从 `agent.skill_paths` 加载，属于指令而非访问控制。

- **Git 工具**限定在对话的 worktree 和本地项目镜像：`git_status`、`git_log`、`git_show`、`git_diff`、`git_branches`、`git_clone`、`git_branch`、`git_checkout`、`git_pull`、`git_sync`、`git_merge`、`git_commit`、`git_push`、`git_publish`、`git_push_branch`、`git_rebase`、`git_cherry_pick`、`git_revert`。不接受任意 URL、远端或强制推送参数；`git_push` 只写镜像中的 `refs/conversations/<id>`，明确要求发布时 `git_publish` 一步保存改动并快进推到 GitLab 具名分支，`git_push_branch` 则是已知完整 SHA 时的底层变体。保存改动后 worktree 会 detached 到保存的提交，因此 `git_rebase` / `git_merge` 面对的是干净工作区，变基/合并结果在轮末同步回会话 ref。轮次排队时抓取的分支快照只用于判断该轮是否过期；未发布改动的基线单独维护，只在成功发布到会话目标分支后前进：只 commit 时改动仍显示在「更改」里，publish 成功后该列表清空，同一轮内可以继续修改并再次发布而无需手动 rebase。推送被拒（非快进）时按 `git_sync` → `git_pull` → `git_rebase` 到 `origin/<branch>` 的顺序恢复，绝不强制推送；每轮 Git 调用次数有上限（`agent.git_tool_call_limit`），失败也计入，超限后停止操作并汇报，避免陷入试错循环。首次发布到功能分支后系统会自动复用或创建 MR（`agent.auto_create_merge_request`）；轮次过期时会在 context 轨迹里记录推进分支的具体提交与作者。
- **GitLab 工具**固定绑定到对话的项目：项目与分支发现、读取 Issue/MR 及其变更与讨论，以及 Issue/MR 的创建、更新、关闭、评论等生命周期操作。所有写操作都需要用户明确意图；删除、合并、批准等不可逆或公开动作在工具描述中明确标注。
- **文件修改**只在工作树中进行，并通过有界的 `write_file` / `edit_file` / `delete_file` / `move_file` / `copy_file` 完成；改动保存到项目镜像的会话 ref，工作区被清理后仍会恢复，且永不 commit 到 GitLab 分支。删除对话或会话改动会移除该 ref。
- 在「设置 → 执行环境」开启后，对话还会获得 `run_command`：自由命令在固定 worktree 中经配置的后端运行（生产用容器沙箱，开发可用本地后端），有命令长度、超时与输出上限；Chat 过程块里实时显示终端输出，并可单独停止某条命令而不取消整轮。技能还可以在 frontmatter 的 `corvex-commands` 里声明固定命令，并用 `corvex-commands-enabled` 开启；模型通过 `run_skill_command` 调用时，声明的命令字符串经同一后端执行，限额、脱敏与终端展示完全一致，模型不能提供命令文本，也不会把用户输入插值进命令。所有 Agent 输出均视为不可信，写入 GitLab 前再次校验授权、取消状态与固定版本。

## 后续阅读

- 阅读[架构与工作流程](./architecture)，了解轮次执行、上下文治理和安全边界。
- 查阅[配置参考](./configuration)中的全部配置项。
- 按照[运行环境与运维](./operations)配置 Docker Compose、健康检查、备份、保留策略和故障排查。
