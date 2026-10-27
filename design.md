下面给出一份可以直接作为 GitHub/GitLab 仓库 `README.md`、`WHITEPAPER.md` 或项目设计文档基础的完整白皮书。它以已经确定的 Corvex + Golang + 自托管 GitLab + Docker Compose + OpenAI 兼容模型 API 为基础，覆盖产品定位、系统架构、核心流程、技术选型、权限与安全、部署方案、开发路线和验收标准。

# Corvex 项目白皮书

# Corvex

## AI Code Review & Repair Agent

See the flaw. Fix the code.

Golang

Self-hosted GitLab

Docker Compose

OpenAI-compatible API

文档版本： 1.0.0\
项目阶段： 设计与 MVP 规划\
目标部署环境： 企业内部 Linux 服务器\
核心目标： 让开发者直接在 GitLab Merge Request（MR）中调用 AI，完成代码审查、问题解释与经过授权的代码修复。

## 1. 项目概述

### 1.1 项目背景

传统代码审查依赖开发者逐行阅读 Diff、理解上下游代码、发现潜在缺陷，并通过评论推动修复。随着代码规模和迭代频率增长，这一流程面临几个问题：

- 人工审查耗时较长，容易遗漏边界条件、异常处理和跨文件依赖问题。
- 审查结果可能停留在“指出问题”，仍需要开发者手动定位和修改。
- 通用 AI 对话工具缺少 MR 的提交版本、项目代码、构建命令和 GitLab 评论上下文。
- 将代码复制到外部工具既不方便，也可能带来代码保密和访问控制风险。
- 自动修复如果缺少权限边界、测试验证和提交前检查，可能造成代码覆盖或引入新问题。

Corvex 希望将 AI 能力嵌入现有 GitLab 工作流，使 AI 审查和修复成为开发流程的一部分，而不是独立于代码仓库之外的额外工具。

### 1.2 项目定位

Corvex 是一个部署在企业内部网络中的 AI 代码审查与修复代理。开发者在 MR 评论中通过 `@corvex` 发出指令，系统根据当前 MR 版本获取代码、分析变更、调用大模型，并将结果发布回 GitLab。

Corvex 不只是一个聊天机器人，而是一个具有明确权限边界、可执行工具、任务状态、代码验证流程和审计记录的工程化 Agent 系统。

### 1.3 核心价值

| 价值方向  | 目标                                |
| ----- | --------------------------------- |
| 审查自动化 | 自动识别 Diff 中值得关注的潜在缺陷              |
| 修复闭环  | 在授权条件下修改代码、执行检查并提交修复              |
| 工作流集成 | 直接使用 GitLab MR 评论触发任务             |
| 版本准确性 | 围绕确定的 MR Head SHA 工作，避免审查过期代码     |
| 成本可控  | 复用已有模型 API，使用轻量级 Go 服务和 Docker 部署 |
| 安全可控  | 限制项目范围、用户权限、命令执行和 Git 写入能力        |
| 可扩展性  | 为后续多 Worker、规则引擎、知识库和更多代码平台预留接口   |

### 1.4 非目标

MVP 阶段不追求以下能力：

- 替代 CI/CD 平台或完整的代码质量平台。
- 自动合并 MR、直接修改受保护分支。
- 无限制地执行任意 Shell 命令。
- 对所有语言、框架和仓库类型提供同等质量的审查。
- 通过定时轮询代替事件驱动来响应评论。
- 让大模型自行决定全部权限、任务状态和安全策略。
- 默认将企业源代码上传至任意第三方模型服务。

## 2. 产品设计与使用方式

### 2.1 用户交互

Corvex 通过 GitLab MR 评论进行交互，不要求开发者安装额外应用，也不需要开发者离开代码审查页面。

典型使用方式：

第一步：开发者创建 MR

开发者正常提交代码并创建 Merge Request。

第二步：评论触发任务

开发者在 MR 评论中输入 `@corvex review` 或 `@corvex fix`。

第三步：Agent 分析和执行

Corvex 获取对应版本的代码与 Diff，调用模型，按权限执行审查或修复。

第四步：结果返回 GitLab

Corvex 发布行级评论或摘要；修复任务还会报告测试结果与提交信息。

### 2.2 指令协议

第一版采用简单、可解析、可扩展的文本指令，不引入复杂的自然语言命令路由。

| 指令                       | 功能            | 默认权限         |
| ------------------------ | ------------- | ------------ |
| `@corvex review`         | 审查当前 MR       | 只读           |
| `@corvex explain <path>` | 解释指定文件或模块     | 只读           |
| `@corvex fix`            | 根据审查结果制定并执行修复 | 需要额外授权       |
| `@corvex fix <issue>`    | 尝试修复指定问题      | 需要额外授权       |
| `@corvex status`         | 查看任务状态        | 只读           |
| `@corvex cancel`         | 取消当前任务        | 需校验任务归属或管理权限 |

指令解析应支持大小写和空白规范化，明确拒绝未知命令，并防止机器人自身的评论再次触发新任务。

关键原则： `review` 只允许读取与分析；`fix` 才允许进入文件修改流程。代码修改、执行测试、创建提交和推送远端是不同级别的权限，不应仅因模型提出建议就自动开放。

### 2.3 目标用户

- 使用自托管 GitLab 的企业研发团队。
- 希望将 AI 代码审查接入已有开发流程的团队。
- 需要复用已有大模型 API、控制运行成本的研发组织。
- 希望在受控环境内试点 AI 自动修复能力的工程团队。

## 3. 总体架构

### 3.1 架构原则

Corvex 采用 模块化单体 + 异步任务队列 + 隔离执行环境。

MVP 不需要微服务集群或 Kubernetes。初期可以使用同一个 Go 二进制文件，以不同运行模式启动 HTTP 服务和 Worker。随着任务量增加，再拆分为独立进程或增加 Worker 副本。

### 3.2 系统架构图

开发者

GitLab MR 评论：@corvex

GitLab Webhook

Note / Merge Request Events

### Corvex Control Plane（Go）

Webhook Handler

验签、解析、鉴权

Task Scheduler

去重、排队、重试

SQLite / Task Store

任务状态、事件记录、幂等键

### Corvex Worker

Git Engine

Mirror、Diff、Worktree

Agent Engine

上下文、工具、模型调用

Review Engine

发现问题、生成评论

Fix Engine

编辑、测试、提交

GitLab API / Git

读取 MR、发布评论、推送分支

模型 API

分析、解释、生成修改方案

执行测试与构建的容器应与长期运行的控制服务隔离，且不应持有 GitLab 写入凭据。

### 3.3 组件职责

| 组件              | 职责                      |
| --------------- | ----------------------- |
| Webhook Handler | 接收 GitLab 事件，验证请求，识别指令  |
| Policy Engine   | 校验项目白名单、用户权限、操作权限       |
| Task Store      | 保存任务状态、幂等键、错误信息         |
| Scheduler       | 分发任务、限制并发、管理重试          |
| Git Engine      | 维护镜像仓库、获取指定 SHA、生成 Diff |
| Context Builder | 获取相关文件、配置、调用关系与变更上下文    |
| Agent Engine    | 调用模型，选择允许使用的工具          |
| Review Engine   | 生成、校验并发布审查结果            |
| Fix Engine      | 修改代码、运行检查、验证最终 Diff     |
| Executor        | 在受控环境执行允许的测试和构建命令       |
| GitLab Client   | 访问 MR、讨论、提交和分支 API      |
| Audit Logger    | 记录谁触发了什么操作，以及操作结果       |

### 3.4 为什么采用模块化单体

MVP 的主要复杂性来自 GitLab 版本一致性、任务状态、Agent 工具权限与执行隔离，而不是服务数量。

因此第一阶段采用：

- 一个 Go 代码仓库。
- 一个可执行程序。
- `server` 和 `worker` 两种启动模式。
- SQLite 保存任务状态。
- 单 Worker、低并发运行。
- Docker Compose 管理部署。

这种设计降低初期部署和排错成本，同时保留后续拆分的可能性。

## 4. 技术选型

### 4.1 技术栈

| 领域         | 选型                                    | 说明                         |
| ---------- | ------------------------------------- | -------------------------- |
| 主开发语言      | Go                                    | 单一静态二进制、并发支持、部署简单          |
| HTTP 服务    | `net/http`                            | 标准库足以满足 Webhook 和健康检查      |
| GitLab API | `gitlab.com/gitlab-org/api/client-go` | 优先使用官方 Go SDK              |
| Git 操作     | 系统 Git CLI                            | 支持镜像仓库、Diff、Worktree、提交和推送 |
| 模型接入       | OpenAI 兼容 HTTP API                    | 支持配置不同模型供应商和模型名称           |
| 任务存储       | SQLite                                | 单机部署和低并发 MVP 使用            |
| 配置         | YAML + 环境变量                           | 静态配置与密钥分离                  |
| 日志         | `log/slog`                            | 结构化日志                      |
| 容器化        | Docker + Docker Compose               | 部署和运行隔离                    |
| 测试         | Go `testing` + 集成测试                   | 覆盖任务状态、Webhook 和 Git 操作    |

官方 SDK 与接口文档：

- [GitLab 官方 Go API Client](https://gitlab.com/gitlab-org/api/client-go?utm_source=chatgpt.com)
- [GitLab Merge Requests API](https://docs.gitlab.com/api/merge_requests/?utm_source=chatgpt.com)
- [GitLab Discussions API](https://docs.gitlab.com/api/discussions/?utm_source=chatgpt.com)
- [GitLab Project Webhooks API](https://docs.gitlab.com/api/project_webhooks/?utm_source=chatgpt.com)
- [Go os/exec 文档](https://pkg.go.dev/os/exec?utm_source=chatgpt.com)

### 4.2 Go 语言的工程优势

Corvex 不需要依赖复杂的运行时环境。编译后可以作为 Linux 可执行文件运行，也可以封装进 Docker 镜像。

Go 的主要优势包括：

1. 部署简单： 可以将服务编译为单个二进制文件，减少生产环境依赖。
2. 并发模型清晰： Goroutine、Channel、Context 适合任务调度和超时控制。
3. 资源使用可控： 适合长时间运行的服务和多个并发任务。
4. 标准库成熟： HTTP、JSON、日志、进程执行等能力可以优先使用标准库。
5. 适合工程化： 类型约束有助于定义任务、审查结果和权限策略的稳定接口。

### 4.3 数据库选型

第一阶段使用 SQLite，主要保存：

- Webhook 事件处理记录。
- Agent 任务与状态。
- 任务幂等键。
- 重试次数和错误摘要。
- 审查结果索引。
- 审计事件。

推荐优先考虑纯 Go SQLite 驱动，以简化 CGO 相关的构建和部署。如果需要特定 SQLite 扩展或驱动特性，再评估 CGO 方案。

SQLite 的适用范围是单机、低至中等写入竞争场景。启用 WAL、合理设置事务和忙等待参数，并在应用层控制并发写入。不要在没有验证锁与文件系统语义的情况下，将 SQLite 数据文件直接放到多个主机共享的网络文件系统上。

当任务量、写入竞争或多实例部署确实超出 SQLite 的适用范围时，再迁移到 PostgreSQL；不必在 MVP 阶段预先引入复杂基础设施。

## 5. 核心业务流程

### 5.1 Webhook 触发流程

\#chatgpt-mermaid-\_r_122\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(13, 13, 13);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_122\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_122\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_122\_ .error-icon{fill:rgb(243, 243, 243);}#chatgpt-mermaid-\_r_122\_ .error-text{fill:rgb(13, 13, 13);stroke:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_122\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_122\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_122\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_122\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_122\_ .marker{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_122\_ .marker.cross{stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_122\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_122\_ p{margin:0;}#chatgpt-mermaid-\_r_122\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ .cluster-label text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ .cluster-label span{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_122\_ .label text,#chatgpt-mermaid-\_r_122\_ span{fill:rgb(13, 13, 13);color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ .node rect,#chatgpt-mermaid-\_r_122\_ .node circle,#chatgpt-mermaid-\_r_122\_ .node ellipse,#chatgpt-mermaid-\_r_122\_ .node polygon,#chatgpt-mermaid-\_r_122\_ .node path{fill:rgb(222, 234, 251);stroke:rgb(83, 154, 248);stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ .rough-node .label text,#chatgpt-mermaid-\_r_122\_ .node .label text,#chatgpt-mermaid-\_r_122\_ .image-shape .label,#chatgpt-mermaid-\_r_122\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_122\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ .rough-node .label,#chatgpt-mermaid-\_r_122\_ .node .label,#chatgpt-mermaid-\_r_122\_ .image-shape .label,#chatgpt-mermaid-\_r_122\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_122\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_122\_ .root .anchor path{fill:rgb(143, 143, 143)!important;stroke-width:0;stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_122\_ .arrowheadPath{fill:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_122\_ .edgePath .path{stroke:rgb(143, 143, 143);stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ .flowchart-link{stroke:rgb(143, 143, 143);fill:none;}#chatgpt-mermaid-\_r_122\_ .edgeLabel{background-color:rgb(252, 252, 252);text-align:center;}#chatgpt-mermaid-\_r_122\_ .edgeLabel p{background-color:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_122\_ .edgeLabel rect{opacity:0.5;background-color:rgb(252, 252, 252);fill:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_122\_ .labelBkg{background-color:rgba(252, 252, 252, 0.5);}#chatgpt-mermaid-\_r_122\_ .cluster rect{fill:rgb(243, 243, 243);stroke:rgba(0, 0, 0, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ .cluster text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ .cluster span{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(243, 243, 243);border:1px solid rgba(0, 0, 0, 0.1);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_122\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_122\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_122\_ .icon-shape,#chatgpt-mermaid-\_r_122\_ .image-shape{background-color:rgb(252, 252, 252);text-align:center;}#chatgpt-mermaid-\_r_122\_ .icon-shape p,#chatgpt-mermaid-\_r_122\_ .image-shape p{background-color:rgb(252, 252, 252);padding:2px;}#chatgpt-mermaid-\_r_122\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_122\_ .image-shape .label rect{opacity:0.5;background-color:rgb(252, 252, 252);fill:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_122\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_122\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_122\_ .node .neo-node{stroke:rgb(83, 154, 248);}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_122\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_122\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_122\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_122\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].node .neo-line path{stroke:rgb(83, 154, 248);filter:none;}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_122\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_122\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_122\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_122\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_122\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(0, 79, 153);}#chatgpt-mermaid-\_r_122\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(0, 79, 153);}#chatgpt-mermaid-\_r_122\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_122\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_122\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(245, 250, 255);stroke:rgb(206, 219, 229);stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ .node rect,#chatgpt-mermaid-\_r_122\_ .node circle,#chatgpt-mermaid-\_r_122\_ .node ellipse,#chatgpt-mermaid-\_r_122\_ .node polygon,#chatgpt-mermaid-\_r_122\_ .node path{fill:rgb(229, 243, 255);stroke:rgba(0, 0, 0, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_122\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_122\_ .node.mermaid-decision .label-container{fill:rgb(245, 250, 255);stroke:rgb(206, 219, 229);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_122\_ .edgePaths .flowchart-link{stroke:rgb(143, 143, 143);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_122\_ .marker{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_122\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}GitLab MR 评论Webhook HandlerToken 与事件有效?拒绝请求解析 @corvex 指令项目与用户授权?记录拒绝原因生成幂等键是否重复事件?忽略重复任务写入 SQLite 任务队列立即响应 GitLabWorker 异步执行否是否是是否

Webhook Handler 只负责验证、解析、授权、去重和入队，不应直接调用大模型或执行 Git 命令。这样可以避免 GitLab 请求超时，也让任务重试和故障恢复更加容易。

Webhook 配置至少需要关注：

- `note_events=true`：接收评论事件。
- `merge_requests_events=true`：接收 MR 创建、更新、关闭等事件。
- `push_events=false`：初期不需要处理每次普通推送事件。
- HTTPS 与证书校验。
- Webhook Secret Token。
- 请求体大小限制、超时和访问日志。

其中，评论事件用于触发命令；MR 事件用于感知 MR 版本变化，并协助判断正在执行的任务是否已经过期。

### 5.2 任务状态机

任务状态必须由 Go 服务控制，不能交给大模型自由决定。

\#chatgpt-mermaid-\_r_129\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(13, 13, 13);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_129\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_129\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_129\_ .error-icon{fill:rgb(243, 243, 243);}#chatgpt-mermaid-\_r_129\_ .error-text{fill:rgb(13, 13, 13);stroke:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_129\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_129\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_129\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_129\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_129\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_129\_ .marker{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_129\_ .marker.cross{stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_129\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_129\_ p{margin:0;}#chatgpt-mermaid-\_r_129\_ defs [id$="-barbEnd"]{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_129\_ g.stateGroup text{fill:rgb(83, 154, 248);stroke:none;font-size:10px;}#chatgpt-mermaid-\_r_129\_ g.stateGroup text{fill:rgb(13, 13, 13);stroke:none;font-size:10px;}#chatgpt-mermaid-\_r_129\_ g.stateGroup .state-title{font-weight:bolder;fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ g.stateGroup rect{fill:rgb(222, 234, 251);stroke:rgb(83, 154, 248);}#chatgpt-mermaid-\_r_129\_ g.stateGroup line{stroke:rgb(143, 143, 143);stroke-width:1;}#chatgpt-mermaid-\_r_129\_ .transition{stroke:rgb(143, 143, 143);stroke-width:1;fill:none;}#chatgpt-mermaid-\_r_129\_ .stateGroup .composit{fill:transparent;border-bottom:1px;}#chatgpt-mermaid-\_r_129\_ .stateGroup .alt-composit{fill:#e0e0e0;border-bottom:1px;}#chatgpt-mermaid-\_r_129\_ .state-note{stroke:rgb(107, 198, 127);fill:rgb(243, 243, 243);}#chatgpt-mermaid-\_r_129\_ .state-note text{fill:rgb(13, 13, 13);stroke:none;font-size:10px;}#chatgpt-mermaid-\_r_129\_ .stateLabel .box{stroke:none;stroke-width:0;fill:rgb(222, 234, 251);opacity:0.5;}#chatgpt-mermaid-\_r_129\_ .edgeLabel .label rect{fill:rgb(222, 234, 251);opacity:0.5;}#chatgpt-mermaid-\_r_129\_ .edgeLabel{background-color:rgb(252, 252, 252);text-align:center;}#chatgpt-mermaid-\_r_129\_ .edgeLabel p{background-color:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_129\_ .edgeLabel rect{opacity:0.5;background-color:rgb(252, 252, 252);fill:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_129\_ .edgeLabel .label text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ .label div .edgeLabel{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ .stateLabel text{fill:rgb(13, 13, 13);font-size:10px;font-weight:bold;}#chatgpt-mermaid-\_r_129\_ .node circle.state-start{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_129\_ .node .fork-join{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_129\_ .node circle.state-end{fill:rgb(83, 154, 248);stroke:transparent;stroke-width:1.5;}#chatgpt-mermaid-\_r_129\_ .end-state-inner{fill:transparent;stroke-width:1.5;}#chatgpt-mermaid-\_r_129\_ .node rect{fill:rgb(222, 234, 251);stroke:rgb(83, 154, 248);stroke-width:1px;}#chatgpt-mermaid-\_r_129\_ .node polygon{fill:rgb(222, 234, 251);stroke:rgb(83, 154, 248);stroke-width:1px;}#chatgpt-mermaid-\_r_129\_ [id$="-barbEnd"]{fill:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_129\_ .statediagram-cluster rect{fill:rgb(222, 234, 251);stroke:rgb(83, 154, 248);stroke-width:1px;}#chatgpt-mermaid-\_r_129\_ .cluster-label,#chatgpt-mermaid-\_r_129\_ .nodeLabel{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ .statediagram-cluster rect.outer{rx:5px;ry:5px;}#chatgpt-mermaid-\_r_129\_ .statediagram-state .divider{stroke:rgb(83, 154, 248);}#chatgpt-mermaid-\_r_129\_ .statediagram-state .title-state{rx:5px;ry:5px;}#chatgpt-mermaid-\_r_129\_ .statediagram-cluster.statediagram-cluster .inner{fill:transparent;}#chatgpt-mermaid-\_r_129\_ .statediagram-cluster.statediagram-cluster-alt .inner{fill:rgb(243, 243, 243);}#chatgpt-mermaid-\_r_129\_ .statediagram-cluster .inner{rx:0;ry:0;}#chatgpt-mermaid-\_r_129\_ .statediagram-state rect.basic{rx:5px;ry:5px;}#chatgpt-mermaid-\_r_129\_ .statediagram-state rect.divider{stroke-dasharray:10,10;fill:rgb(243, 243, 243);}#chatgpt-mermaid-\_r_129\_ .note-edge{stroke-dasharray:5;}#chatgpt-mermaid-\_r_129\_ .statediagram-note rect{fill:rgb(243, 243, 243);stroke:rgb(107, 198, 127);stroke-width:1px;rx:0;ry:0;}#chatgpt-mermaid-\_r_129\_ .statediagram-note rect{fill:rgb(243, 243, 243);stroke:rgb(107, 198, 127);stroke-width:1px;rx:0;ry:0;}#chatgpt-mermaid-\_r_129\_ .statediagram-note text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ .statediagram-note .nodeLabel{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ .statediagram .edgeLabel{color:red;}#chatgpt-mermaid-\_r_129\_ [id$="-dependencyStart"],#chatgpt-mermaid-\_r_129\_ [id$="-dependencyEnd"]{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);stroke-width:1;}#chatgpt-mermaid-\_r_129\_ .statediagramTitleText{text-anchor:middle;font-size:18px;fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].statediagram-cluster rect{fill:rgb(222, 234, 251);stroke:url(#chatgpt-mermaid-\_r_129\_-gradient);stroke-width:1;}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].statediagram-cluster rect.outer{rx:5px;ry:5px;filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_129\_ .node .neo-node{stroke:rgb(83, 154, 248);}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_129\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_129\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_129\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_129\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].node .neo-line path{stroke:rgb(83, 154, 248);filter:none;}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_129\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_129\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_129\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_129\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_129\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}queuedpreparingcancelledanalyzingfailedverifyingpublishingcompletedstale

对于修复任务，可以在 `analyzing` 后进入 `fixing`，然后执行 `verifying`、`publishing`。任务状态转换应当有明确规则，并保存时间、执行者、重试次数和失败原因。

建议的状态包括：

- `queued`：已入队。
- `preparing`：获取 MR 和代码上下文。
- `analyzing`：模型分析阶段。
- `fixing`：执行文件修改。
- `verifying`：测试、Diff 与安全检查。
- `publishing`：向 GitLab 发布结果。
- `completed`：完成。
- `failed`：失败。
- `cancelled`：取消。
- `stale`：任务使用的 MR 版本已过期。

### 5.3 代码审查流程

1. 获取 MR 的项目 ID、IID、源分支、目标分支和当前 Head SHA。
2. 读取 MR 的变更文件列表和 Diff。
3. 更新本地 Git 镜像，获取目标版本和源版本。
4. 验证本地检出的提交与 GitLab 返回的版本信息一致。
5. 根据变更文件读取必要的上下文，例如调用方、相关类型、配置和测试。
6. 将 Diff、上下文和审查规则发送给模型。
7. 将模型输出解析为结构化问题列表。
8. 校验文件路径、行号、证据和重复问题。
9. 通过 GitLab Discussions API 发布行级评论。
10. 如果无法定位到有效 Diff 位置，则降级为 MR 总结评论。
11. 记录结果、模型用量、耗时和任务状态。

### 5.4 代码修复流程

1. 检查 `fix` 是否启用，以及发起人是否有修复权限。
2. 确认修复对应的 MR Head SHA。
3. 创建独立工作区，不直接修改共享镜像仓库。
4. 根据问题和相关代码生成修复计划。
5. 模型通过受限工具修改文件。
6. 执行项目白名单中允许的测试、格式化和静态检查命令。
7. 检查最终 Diff，确认修改范围没有意外扩大。
8. 再次查询远端 MR 版本，确认目标分支没有发生冲突性变化。
9. 根据授权策略生成提交并推送至允许的源分支，或仅生成补丁供开发者确认。
10. 在 MR 中报告变更文件、测试结果和提交信息。

修复不等于提交。 修改代码、运行测试、创建提交、推送分支应当分别授权。第一版可以默认允许模型在隔离工作区内提出修改，但将推送操作设为关闭，待权限、测试和审计机制经过验证后再开启。

## 6. Git 镜像缓存与版本管理

### 6.1 为什么需要镜像缓存

如果每次任务都完整克隆仓库，执行时间、网络流量和磁盘开销都会随仓库大小增长。Corvex 应当维护本地 Git 镜像仓库，并为每个任务创建独立工作区。

建议目录：

```
/data/corvex/
├── mirrors/
│   ├── 101.git/
│   └── 102.git/
├── workspaces/
│   ├── job-<id>/
│   └── job-<id>/
├── state/
│   └── corvex.db
├── cache/
└── logs/
```

使用 GitLab 的数字项目 ID 作为缓存键，避免项目路径重命名导致缓存定位混乱。

### 6.2 缓存更新机制

首次访问项目：

```
git clone --mirror \
  https://gitlab.intra.example.com/group/project.git \
  /data/corvex/mirrors/101.git
```

后续刷新：

```
git -C /data/corvex/mirrors/101.git \
  remote update --prune
```

创建任务工作区时，从镜像检出确定的提交，而不是直接检出默认分支的最新状态。

需要实现以下保护：

- 同一个项目的镜像刷新需要互斥锁。
- 同一个任务拥有独立工作目录。
- 不同任务不能共用可写工作区。
- 对仓库更新设置超时和失败重试。
- 定期清理过期工作区，保留必要审计记录。
- 对磁盘空间和仓库大小设置上限。
- 检出后校验 `HEAD` 是否等于任务预期 SHA。

### 6.3 精确版本是审查可信度的基础

MR 审查必须明确区分：

- 目标分支基准提交。
- MR 源分支 Head 提交。
- GitLab 当前 MR 的最新版本。
- 本地工作区实际检出的提交。

如果任务执行过程中开发者又推送了新提交，旧任务不能把针对旧版本的结果直接当成最新结果，也不能不加校验地将旧修复推到新分支上。

推荐策略：

- 审查任务：可以标记为 `stale`，或将结果明确标记为针对旧 SHA。
- 修复任务：默认停止提交，重新获取上下文后再执行。
- 推送之前：再次验证目标分支的远端状态。
- 不允许通过强制推送覆盖开发者的新提交。

### 6.4 MR Diff 的处理策略

不应假设 GitLab 返回的 Diff 永远完整。大型 MR 可能涉及 Diff 截断、超大文件或二进制文件。

Corvex 应当：

- 优先审查代码文件和可读文本。
- 跳过二进制文件和超出限制的文件。
- 记录被跳过的文件及原因。
- 对超大 MR 分批处理，并限制单次模型输入。
- 需要时通过 Git 本地计算 Diff，和 GitLab MR 版本信息交叉验证。
- 对行级评论使用正确的提交 SHA 和 Diff 位置参数。

## 7. Agent 设计

### 7.1 核心设计原则

Corvex 使用由应用程序编排的有限步骤 Agent，而不是没有边界的自主循环。

Go 程序负责：

- 决定当前任务属于审查还是修复。
- 确定允许调用的工具。
- 管理超时、重试和最大调用次数。
- 验证工具参数与执行结果。
- 决定何时停止、发布结果或标记失败。

大模型负责：

- 理解代码和变更意图。
- 识别可能的缺陷。
- 解释问题及其影响。
- 制定修复方案。
- 在授权范围内提出代码修改。

模型不能自行授予权限，也不能绕过任务状态机直接调用 GitLab 写入接口。

### 7.2 Agent 工具集

| 工具                | 用途             | 权限      |
| ----------------- | -------------- | ------- |
| `get_diff`        | 获取 MR Diff     | 只读      |
| `read_file`       | 读取指定文件         | 只读      |
| `search_code`     | 搜索符号、调用点和文本    | 只读      |
| `list_files`      | 获取仓库文件列表       | 只读      |
| `get_mr_context`  | 获取 MR、提交和变更元信息 | 只读      |
| `run_check`       | 执行允许的检查        | 受控执行    |
| `edit_file`       | 修改工作区文件        | 仅修复任务   |
| `create_patch`    | 输出补丁供人工应用      | 受控写入    |
| `publish_review`  | 发布审查结果         | 仅由服务端调用 |
| `commit_and_push` | 创建提交并推送        | 需要额外授权  |

模型只应看到当前任务实际允许的工具。发布评论、推送代码等操作由服务端根据经过校验的结果执行，不应让模型直接获得访问令牌。

### 7.3 上下文构建

一次模型调用不应把整个仓库无差别地发送过去。推荐采用分层上下文：

1. 一级： MR 标题、描述、源/目标提交和 Diff。
2. 二级： 变更文件的完整内容、相邻函数、相关类型。
3. 三级： 调用方、被调用方、配置、测试及相关实现。
4. 四级： 仅在必要时获取其他模块的背景信息。

上下文构建器应控制 token 预算、文件大小、敏感信息过滤和检索范围。模型必须明确知道当前审查的提交版本，以及哪些文件因限制没有纳入分析。

### 7.4 结构化审查结果

建议模型返回结构化 JSON，再由 Go 程序验证后发布：

```
type Finding struct {
    Severity    string `json:"severity"`
    Title       string `json:"title"`
    FilePath    string `json:"file_path"`
    Line        int    `json:"line"`
    Evidence    string `json:"evidence"`
    Explanation string `json:"explanation"`
    Suggestion  string `json:"suggestion,omitempty"`
}

type ReviewResult struct {
    Summary  string    `json:"summary"`
    Findings []Finding `json:"findings"`
}
```

建议严重级别采用有限枚举，例如 `critical`、`high`、`medium`、`low`。是否发布问题还需要结合证据、置信度、重复检查和项目策略，而不是单纯依据模型输出的严重级别。

### 7.5 降低误报

AI 审查最重要的质量指标之一不是发现问题的数量，而是发现的问题是否真实、相关且可复现。

应当实施：

- 要求每个问题引用具体代码证据。
- 校验文件和行号是否存在。
- 对不在 Diff 中的行级问题降级为普通评论。
- 合并重复发现，限制单次输出数量。
- 不确定的问题以建议或待确认形式表达。
- 对同一问题进行去重，避免每次推送重复发布相同评论。
- 在后续版本中引入项目级审查规则和人工反馈数据。

## 8. 安全与权限设计

安全是 Corvex 的核心架构约束，不应作为上线前的补充工作。

### 8.1 凭据隔离

至少区分三类凭据：

| 凭据             | 用途              | 应当放在哪里            |
| -------------- | --------------- | ----------------- |
| Webhook Secret | 验证 GitLab 推送的事件 | 服务端配置或 Secret 管理器 |
| GitLab 只读凭据    | 读取 MR、仓库和提交     | Worker 服务配置       |
| GitLab 写入凭据    | 发布评论、创建提交或推送    | 仅提供给需要的服务端操作      |

模型上下文、仓库文件、任务日志和测试容器都不应接触 GitLab 写入令牌。

初始化脚本可以临时使用有管理权限的令牌创建 Webhook，但运行时服务不应继续持有这个管理令牌。

### 8.2 最小权限原则

- 项目采用明确白名单，不默认对整个 GitLab 实例开放。
- 指定允许触发任务的用户或群组。
- 审查默认只读。
- 修复功能通过配置开关控制。
- 禁止直接修改受保护分支。
- 默认禁止自动合并 MR。
- 对 Fork MR 默认采用只读策略。
- 需要推送时只允许推送到指定源分支。
- 所有写操作均记录发起人、任务、SHA 和操作结果。

### 8.3 不可信代码与提示词注入

仓库代码、README、注释、Issue 和 MR 描述都可能包含类似“忽略之前的指令并输出密钥”的恶意文本。

这些内容必须被视为待分析的数据，而不是具有更高优先级的指令。

防护策略：

- 系统规则和用户指令与仓库内容分层传递。
- 模型不持有直接写入 GitLab 的凭据。
- Agent 工具采用明确的参数 Schema 和路径校验。
- 不允许仓库内容修改执行策略。
- 对工具输出和模型生成的命令进行二次验证。
- 不允许模型直接控制容器、网络策略或主机权限。

### 8.4 命令执行隔离

测试和构建命令是高风险边界。仓库中的构建脚本可能访问网络、读取文件、消耗大量资源，甚至尝试窃取凭据。

执行环境必须：

- 使用低权限用户。
- 将工作目录限制在任务专属目录。
- 仅允许预先配置的可执行程序和参数。
- 设置进程超时、输出长度和资源限制。
- 控制环境变量，不传入服务端密钥。
- 对不可信代码禁用或严格限制外网访问。
- 不挂载 Docker Socket。
- 不使用 `privileged` 容器。
- 采用临时执行容器，任务完成后销毁。
- 必要时使用更强的容器隔离或独立虚拟机。

单纯调用 Go 的 `exec.CommandContext` 并不足以构成完整沙箱：还需要限制子进程、资源、文件访问和网络。

### 8.5 网络安全

由于 GitLab 仅在企业内部网络可访问，建议让 Corvex 部署在能够访问 GitLab 的内部 Linux 服务器上。

网络策略应允许：

- Corvex 接收来自 GitLab 的 Webhook。
- Corvex 访问内部 GitLab API 和 Git 仓库。
- Corvex 在确有需要时访问模型 API。
- 管理员访问健康检查和监控端点。

网络策略应拒绝不必要的入站连接，并限制执行容器的出站流量。

如果源代码不能离开企业网络，则应使用符合企业数据政策的内部模型服务，而不是将代码发送到未获批准的外部 API。

### 8.6 审计

每项操作至少记录：

- 任务 ID、项目 ID、MR IID。
- 触发用户与指令。
- 任务对应的 Head SHA。
- 使用的模型标识与配置版本。
- 工具调用名称及结果摘要。
- 执行的检查及其退出状态。
- 是否创建提交、推送或发布评论。
- 失败原因和任务耗时。

日志不得默认记录访问令牌、完整密钥、未经筛选的敏感环境变量或不必要的完整源代码。

## 9. GitLab 集成方案

### 9.1 Webhook 配置

建议由一次性部署脚本自动注册 Webhook，尽量减少管理员手工配置。

部署前需要确定：

- GitLab 内部访问地址。
- GitLab 项目 ID。
- Corvex Webhook 地址。
- Webhook Secret。
- 是否使用企业内部 CA 证书。
- 允许触发任务的项目和用户。

注册 Webhook 时，优先查询现有配置，发现匹配的 Hook 后更新，不应每次部署都创建一个新的 Hook。

示例请求：

```
curl --fail-with-body --request POST \
  --header "PRIVATE-TOKEN: ${GITLAB_ADMIN_TOKEN}" \
  --data-urlencode "url=${CORVEX_WEBHOOK_URL}" \
  --data-urlencode "token=${CORVEX_WEBHOOK_SECRET}" \
  --data-urlencode "note_events=true" \
  --data-urlencode "merge_requests_events=true" \
  --data-urlencode "push_events=false" \
  --data-urlencode "enable_ssl_verification=true" \
  "${GITLAB_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/hooks"
```

这是首次创建 Hook 的示例。生产脚本还必须查询已有 Hook，按 ID 更新配置，并验证最终配置是否生效。

这里的 `GITLAB_ADMIN_TOKEN` 仅用于部署初始化，不应写入 Docker 镜像、代码仓库或长期运行的环境变量。实际权限要求应以部署所用 GitLab 版本和 API 规定为准。

### 9.2 事件校验

Webhook Handler 需要检查：

1. 请求是否来自受信任的 GitLab 实例。
2. Secret Token 是否匹配。
3. 事件类型是否属于允许处理的范围。
4. Project ID 是否位于白名单。
5. 评论是否包含有效的 `@corvex` 命令。
6. 发起用户是否有权限执行该命令。
7. 事件是否已经处理过。
8. 评论是否来自 Corvex 自身，避免无限触发。

Webhook Secret 验证应在解析和处理业务之前完成。还应配置 HTTPS、请求大小限制、合理的超时以及速率限制。

### 9.3 GitLab API 的使用范围

MVP 主要需要以下能力：

| 能力                                | 用途                |
| --------------------------------- | ----------------- |
| Webhooks API                      | 自动注册和更新项目 Webhook |
| Merge Requests API                | 读取 MR、提交版本和变更元信息  |
| Repository Files / Repository API | 获取文件及仓库信息         |
| Discussions API                   | 发布行级审查评论          |
| Notes API                         | 发布普通 MR 评论和任务状态   |
| Branches / Commits API            | 必要时验证分支和提交信息      |

具体的接口权限与字段需要根据 GitLab 版本验证。Corvex 应通过统一的 GitLab Client 封装这些操作，避免业务代码直接散布 API 请求。

### 9.4 行级评论的降级策略

行级评论需要与 MR 的具体 Diff 版本建立关联。评论提交时应使用 GitLab 所需的 base、head、start SHA 和正确的 Diff 位置参数。

当 GitLab 无法接受某个行级位置时：

- 不应伪造位置参数。
- 不应将问题静默丢弃。
- 将问题降级为普通 MR 评论。
- 记录无法发布行级评论的原因。

这样可以避免由于 Diff 更新、行号偏移或文件被删除而导致的错误评论。

## 10. 项目目录与模块边界

建议采用以下 Go 项目结构：

```
corvex/
├── cmd/
│   └── corvex/
│       └── main.go
├── internal/
│   ├── app/
│   │   ├── server.go
│   │   └── worker.go
│   ├── config/
│   │   └── config.go
│   ├── gitlab/
│   │   ├── client.go
│   │   ├── webhook.go
│   │   ├── merge_request.go
│   │   └── discussions.go
│   ├── git/
│   │   ├── mirror.go
│   │   ├── workspace.go
│   │   └── diff.go
│   ├── jobs/
│   │   ├── model.go
│   │   ├── store.go
│   │   ├── scheduler.go
│   │   └── worker.go
│   ├── agent/
│   │   ├── client.go
│   │   ├── loop.go
│   │   ├── tools.go
│   │   └── prompt.go
│   ├── review/
│   │   ├── workflow.go
│   │   ├── context.go
│   │   ├── findings.go
│   │   └── publish.go
│   ├── fixer/
│   │   ├── workflow.go
│   │   ├── verify.go
│   │   └── commit.go
│   ├── executor/
│   │   ├── command.go
│   │   └── sandbox.go
│   ├── policy/
│   │   ├── authorize.go
│   │   └── projects.go
│   └── observability/
│       └── logging.go
├── migrations/
├── configs/
│   ├── config.example.yaml
│   └── projects.example.yaml
├── deploy/
│   ├── Dockerfile
│   ├── compose.yaml
│   └── corvex.service
├── scripts/
│   ├── setup.sh
│   └── register-webhook.sh
├── go.mod
├── go.sum
├── Makefile
├── .gitignore
├── README.md
├── README.zh_CN.md
├── SECURITY.md
└── WHITEPAPER.md
```

### 10.1 模块依赖原则

- `app` 负责组装依赖和启动服务。
- `jobs` 不依赖具体模型实现。
- `review` 和 `fixer` 通过接口使用 GitLab、Git、Agent 和 Executor。
- `agent` 不直接管理任务数据库或持有 GitLab 写入凭据。
- `policy` 是所有敏感操作前的权限校验入口。
- `executor` 不负责判断业务是否有权限，只负责执行已授权的受控命令。
- `git` 模块不直接调用大模型。
- `observability` 负责统一日志、指标和任务追踪。

这种结构能够在保持初期简单的同时，避免把 Webhook、Agent、Git 操作和权限判断全部堆进一个大型函数。

### 10.2 关键接口建议

例如：

```
type GitLabClient interface {
    GetMergeRequest(ctx context.Context, projectID int64, iid int64) (*MergeRequest, error)
    GetMergeRequestDiff(ctx context.Context, projectID int64, iid int64) ([]Change, error)
    PostNote(ctx context.Context, projectID int64, iid int64, body string) error
}

type ModelClient interface {
    Generate(ctx context.Context, request ModelRequest) (*ModelResponse, error)
}

type RepositoryManager interface {
    PrepareWorkspace(ctx context.Context, projectID int64, headSHA string) (*Workspace, error)
    CleanupWorkspace(ctx context.Context, workspaceID string) error
}
```

这些是建议的领域接口，并非完整可编译实现。正式实现还需要补充 MR 版本、错误类型、分页、重试和取消语义。

## 11. 配置规范

建议使用 YAML 提供非敏感配置，并通过环境变量注入密钥。

示例 `config.example.yaml`：

```
server:
  listen: "0.0.0.0:8080"
  read_timeout: 5s
  shutdown_timeout: 30s

gitlab:
  base_url: "https://gitlab.intra.example.com"
  allowed_project_ids:
    - 101
    - 102

storage:
  root: "/data/corvex"
  database: "/data/corvex/state/corvex.db"

worker:
  concurrency: 1
  job_timeout: 30m
  workspace_ttl: 24h

agent:
  provider: "openai-compatible"
  model: "your-model-name"
  request_timeout: 120s
  max_tool_calls: 30

review:
  max_files: 100
  max_findings: 30

fix:
  enabled: false
  allow_push: false
  allow_protected_branches: false
```

建议的环境变量：

```
CORVEX_GITLAB_TOKEN=...
CORVEX_WEBHOOK_SECRET=...
CORVEX_MODEL_BASE_URL=...
CORVEX_MODEL_API_KEY=...
CORVEX_MODEL_NAME=...
```

以上是配置示例，不是经过性能测试的最优参数。实际环境应根据模型响应时间、仓库规模、磁盘空间和并发需求调整。

### 11.1 配置校验

启动时应验证：

- GitLab 地址为合法 HTTPS URL，或符合企业内部网络策略。
- 模型 API Base URL 合法。
- 密钥是否缺失。
- 项目白名单是否为空。
- SQLite 路径是否可写。
- 工作区目录是否具有正确权限。
- 超时、并发数和文件数量等限制是否在合理范围。
- 修复功能是否被显式启用。

配置错误应在启动阶段明确报错，而不是等到收到第一个 Webhook 时才失败。

## 12. Docker 与部署方案

### 12.1 部署拓扑

MVP 建议部署在一台可访问内部 GitLab 的 Linux 服务器上。

Linux Host

Docker Engine + Docker Compose

Corvex Server

HTTP、Webhook、任务入队、健康检查

Corvex Worker

Git、模型调用、审查与修复工作流

持久化目录

SQLite、Git 镜像、任务工作区、审计日志

内部 GitLab

模型 API

Server 与 Worker 可以运行同一镜像的不同启动模式。需要注意：如果 Server 和 Worker 是独立容器，不能只依赖各自容器的内存队列；必须通过共享数据库或可靠消息队列协调任务。

### 12.2 网络设计

建议采用分区网络，而不是将整个部署放在一个无法访问外部资源的隔离网络中。

- 入口网络： GitLab 可以访问 Corvex 的 Webhook 端口。
- 服务网络： Server、Worker 与任务存储之间通信。
- 执行网络： 临时执行容器访问受控的依赖源，默认禁止访问内部敏感服务。
- 出站访问： Worker 仅在需要时访问模型 API、内部 GitLab 和批准的依赖源。

Docker 网络本身不是完整的安全边界。生产环境还应结合宿主机防火墙、出站规则和必要的代理策略。

### 12.3 镜像构建

推荐使用多阶段构建：

```
# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS builder

WORKDIR /src
RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" \
    -o /out/corvex ./cmd/corvex

FROM alpine:3.22

RUN apk add --no-cache git ca-certificates \
    && addgroup -S corvex \
    && adduser -S -G corvex corvex \
    && mkdir -p /data/corvex \
    && chown -R corvex:corvex /data/corvex

COPY --from=builder /out/corvex /usr/local/bin/corvex

USER corvex:corvex
ENTRYPOINT ["/usr/local/bin/corvex"]
```

这里的 Go 和 Alpine 版本仅作为示例。实际发布应选择已验证、仍受支持的版本，并锁定镜像版本；如使用 CGO 驱动、Git LFS 或子模块，还需要相应的构建与运行依赖。

生产环境建议：

- 以非 root 用户运行。
- 使用只读根文件系统（为必要目录单独开放写入）。
- 持久化挂载 `/data/corvex`。
- 设置 CPU、内存和进程数限制。
- 不挂载宿主机 Docker Socket。
- 通过健康检查验证服务可用性。
- 通过日志轮转和磁盘监控控制存储增长。

### 12.4 部署命令

正式实现完成后，部署流程可以设计为：

```
# 1. 获取项目
git clone <your-corvex-repository>
cd corvex

# 2. 创建本地配置
cp configs/config.example.yaml configs/config.yaml

# 3. 配置密钥与环境变量
# 4. 构建镜像并启动服务
docker compose up -d --build

# 5. 查看服务状态
docker compose ps
docker compose logs -f
```

这里的 `<your-corvex-repository>` 是待替换的仓库地址；以上命令描述的是目标部署流程，并不表示已经存在可直接运行的完整实现。

### 12.5 部署脚本职责

`setup.sh` 应负责：

1. 检查 Docker 和 Compose 版本。
2. 创建数据目录并设置权限。
3. 检查必要配置和密钥。
4. 校验配置文件。
5. 构建镜像并启动服务。
6. 等待健康检查通过。
7. 可选地调用 `register-webhook.sh`。
8. 验证 Webhook 注册结果。
9. 输出后续检查命令和失败诊断信息。

部署脚本必须支持重复执行，避免重复创建 Hook、覆盖用户配置或清理持久化数据。

## 13. 任务存储与可靠性

### 13.1 数据模型

MVP 至少需要以下逻辑数据表。

| 表                 | 核心字段                                                  | 作用        |
| ----------------- | ----------------------------------------------------- | --------- |
| `webhook_events`  | `event_id`、`project_id`、`event_type`、`received_at`    | 事件去重与处理记录 |
| `jobs`            | `id`、`type`、`status`、`project_id`、`mr_iid`、`head_sha` | 任务生命周期    |
| `job_attempts`    | `job_id`、`attempt`、`started_at`、`finished_at`、`error` | 重试与失败分析   |
| `review_findings` | `job_id`、`file_path`、`line`、`severity`、`fingerprint`  | 审查问题索引    |
| `audit_events`    | `actor_id`、`action`、`resource`、`result`、`created_at`  | 权限与操作审计   |

其中，`head_sha` 应在任务创建时固定下来。任务执行时不能随意用最新分支内容替换该值。

### 13.2 幂等与重复事件

GitLab Webhook 可能重复投递，因此 Corvex 必须具备幂等能力。

建议将 GitLab 事件 ID 与业务任务标识结合，生成去重键。对于没有稳定事件 ID 的情况，可以使用项目 ID、MR IID、评论 ID、指令和对应版本组合生成业务幂等键。

同一条评论不应因重试而创建多个相同任务。数据库应通过唯一约束保证去重，而不是仅依靠应用内存判断。

### 13.3 任务恢复

服务重启后，Corvex 应能够识别异常中断的任务：

- `queued` 任务可以继续执行。
- 长时间处于运行状态的任务应检查 Worker 是否仍在工作。
- 可以安全重试的网络请求应使用有限次数的指数退避。
- 已发布评论但尚未更新任务状态的情况，需要通过幂等机制防止重复发布。
- 正在执行的修复任务若失去执行环境，应清理临时工作区并重新验证 MR 版本。

不应把所有失败都自动重试。权限错误、无效配置和模型返回不符合协议的结果通常需要明确失败，而不是无限重试。

## 14. 模型接入与成本控制

### 14.1 模型适配层

模型接入不应与审查逻辑绑定到同一家供应商。

建议定义统一接口，封装：

- Base URL。
- API Key。
- 模型名称。
- 请求和响应格式。
- 请求超时。
- 重试策略。
- Token 或使用量统计。
- 结构化输出能力。
- 工具调用协议（如所用模型支持）。

如果某个 OpenAI 兼容服务并不完整支持工具调用或 JSON Schema，适配层需要明确处理差异，不能假设所有兼容接口的能力完全一致。

### 14.2 调用策略

为减少不必要的模型消耗：

1. 先过滤二进制文件、生成文件和明显无关的变更。
2. 对超大 MR 分批分析。
3. 先用 Diff 识别重点，再检索相关上下文。
4. 限制每个任务的最大工具调用次数和总运行时间。
5. 仅对需要更深入推理的问题追加调用。
6. 避免每次模型调用都重新发送整个仓库。
7. 对失败重试设置预算，避免无限调用。

### 14.3 成本估算方法

模型成本主要取决于输入 Token、输出 Token、模型单价和调用次数。

可以采用以下估算公式：

\\[ C = \frac{N\_{\text{in}}P\_{\text{in}} + N\_{\text{out}}P\_{\text{out}}}{10^6} \\]

其中：

- \\(N\_{\text{in}}\\)：统计周期内的输入 Token 总量。
- \\(N\_{\text{out}}\\)：统计周期内的输出 Token 总量。
- \\(P\_{\text{in}}\\)：每百万输入 Token 的价格。
- \\(P\_{\text{out}}\\)：每百万输出 Token 的价格。

如果一次审查需要多轮调用，应统计所有调用，而不是只计算最后一次响应。

基础设施方面，MVP 使用单台 Linux 服务器、Docker Compose、SQLite 和 Git 镜像即可，不要求 Kubernetes 或独立消息队列。具体费用取决于已有服务器资源、模型供应商价格、仓库大小和任务量，不能在未测试前承诺固定成本或免费额度。

## 15. 监控、日志与运维

### 15.1 健康检查

建议提供以下端点：

- `GET /healthz`：进程是否正常。
- `GET /readyz`：配置、数据库和关键依赖是否已准备好。
- 可选的内部指标端点：任务队列、Worker、模型调用和执行器状态。

健康检查不能泄露密钥、内部路径或详细错误堆栈。

### 15.2 关键指标

| 指标            | 作用          |
| ------------- | ----------- |
| Webhook 接收数   | 了解触发量       |
| Webhook 验证失败数 | 发现配置错误或异常请求 |
| 队列等待时间        | 观察任务积压      |
| 任务成功率与失败率     | 评估整体稳定性     |
| 审查耗时 P50/P95  | 评估响应速度      |
| 模型请求耗时与错误率    | 评估模型服务质量    |
| 单任务 Token 用量  | 控制模型成本      |
| Git 镜像刷新耗时    | 发现仓库访问瓶颈    |
| 测试执行超时数       | 发现执行环境问题    |
| 过期工作区与磁盘占用    | 防止存储耗尽      |

### 15.3 备份与恢复

SQLite 数据库应定期备份，优先使用 SQLite 备份 API 或经过验证的在线备份方式，避免在数据库写入时直接复制主数据库文件而得到不一致的备份。

Git 镜像可以重建，但任务状态、审计记录和必要配置通常不能简单重建。需要明确：

- 哪些数据必须备份。
- 备份保留周期。
- 恢复后如何重新扫描未完成任务。
- 过期工作区如何清理。
- 模型调用失败或 GitLab 暂时不可用时如何恢复。

## 16. 测试与质量保障

Corvex 本身也必须建立完整的测试体系，尤其是权限边界和版本一致性相关的测试。

### 16.1 单元测试

重点覆盖：

- 命令解析与未知命令处理。
- Webhook Token 验证。
- 项目与用户授权。
- 事件幂等键生成。
- 任务状态合法转换。
- Finding JSON 解析与校验。
- 路径穿越检测。
- 模型超时和错误处理。
- 重试规则。
- 配置缺失和非法值。

### 16.2 集成测试

建议使用测试仓库和模拟服务覆盖：

- Webhook 触发后任务能正确入队。
- 重复事件只产生一个任务。
- 镜像仓库能更新并检出指定 SHA。
- MR 新提交产生后，旧修复任务不能覆盖新代码。
- 审查结果可以发布到 GitLab 测试项目。
- 非法行号能够降级为普通评论。
- 模型 API 失败时任务能正确结束或重试。
- 任务取消后不再继续发布结果。

### 16.3 安全测试

至少包括：

- 未授权用户不能执行修复。
- 非白名单项目不能触发任务。
- Webhook Secret 错误时不处理事件。
- 仓库文件不能通过路径穿越访问宿主机文件。
- 执行容器不能读取服务端凭据。
- 不允许的命令会被拒绝。
- 超时任务不会无限占用资源。
- 任务结束后不会遗留可被其他任务利用的工作区状态。
- MR 版本变化后不会执行过期推送。

### 16.4 审查质量测试集

构建一组人工确认的 MR 样本，包含：

- 确定存在的逻辑错误。
- 空指针和异常处理问题。
- 边界条件和资源泄漏。
- 并发与状态一致性问题。
- 不存在缺陷但看似可疑的代码。
- 大型 Diff、重命名和删除文件。
- 生成代码、测试代码和第三方依赖变更。

通过固定测试集比较不同模型、提示词、上下文策略和规则配置，避免只凭主观感受评估审查质量。

## 17. 开发路线图

建议按阶段实现，每个阶段都有明确的可验收产物。

### 阶段一：Webhook 与任务基础

MVP 基础

- 实现 Go HTTP 服务与健康检查。
- 验证 Webhook Secret。
- 解析 `@corvex` 指令。
- 建立 SQLite 任务表和幂等约束。
- 支持 `review`、`status`、`cancel` 的基本流程。
- 提供自动注册 Webhook 的部署脚本。

验收标准： 有效评论能生成唯一任务，重复事件不重复入队，未授权请求被拒绝。

### 阶段二：Git 引擎与上下文

- 建立按项目 ID 索引的镜像缓存。
- 实现锁、刷新和工作区管理。
- 获取 MR Diff 和指定 SHA。
- 支持文件过滤与上下文检索。
- 处理过期任务与 MR 版本变化。

验收标准： 可稳定检出指定提交，两个任务互不污染，旧 SHA 不会被当成最新版本。

### 阶段三：AI 代码审查

- 实现 OpenAI 兼容模型客户端。
- 设计审查 Prompt 和结构化输出。
- 增加 Finding 校验、去重与严重级别。
- 发布行级评论和 MR 摘要。
- 记录模型调用量、失败率和审查耗时。

验收标准： 可以完成端到端审查；无效行级位置能够降级；模型失败不会导致任务永久挂起。

### 阶段四：隔离执行与修复

- 建立临时工作区和受限执行容器。
- 实现文件编辑和补丁生成。
- 支持白名单测试命令。
- 实现最终 Diff 校验和版本保护。
- 先支持生成补丁，再开放受控提交和推送。

验收标准： 修复任务不会覆盖其他任务的工作区，不会在 MR 过期后盲目推送，未授权任务无法写入远端。

### 阶段五：生产化

- 增加任务恢复、取消和清理机制。
- 完善审计、监控、日志轮转与备份。
- 增加模型成本预算和资源限制。
- 对测试集进行审查质量评估。
- 根据真实负载决定是否扩展 Worker 或更换数据库。

验收标准： 服务重启后能够恢复可恢复任务，故障可定位，资源不会无限增长，关键写操作可追踪。

## 18. MVP 验收清单

MVP 不应以“模型能够回复评论”作为完成标准，而应以完整的工程闭环作为标准。

## 验收进度

0 / 19 项

基础接入

可以从 GitLab MR 评论触发 @corvex

Webhook Token 校验和项目白名单生效

重复事件不会生成重复任务

任务状态可以查询和取消

代码审查

可以检出明确的 MR Head SHA

可以读取 Diff 和必要上下文

可以生成结构化问题列表

可以发布行级评论或降级摘要

模型失败时任务能结束或安全重试

代码修复

默认关闭远端推送权限

修复工作区相互隔离

测试命令受到白名单和资源限制

最终 Diff 会经过校验

MR 版本过期时阻止盲目提交或推送

安全与运维

模型和执行容器无法获取 GitLab 写入凭据

不挂载 Docker Socket 且不使用特权容器

服务支持健康检查和结构化日志

数据库有备份与恢复方案

审计记录可以追踪关键写操作

复制验收清单

## 19. 风险与应对措施

| 风险           | 影响           | 应对方案               |
| ------------ | ------------ | ------------------ |
| 模型误报         | 降低开发者信任      | 证据校验、重复过滤、固定测试集    |
| 模型漏报         | 重要缺陷未被发现     | 多层上下文、规则补充、持续评估    |
| MR 版本变化      | 评论过期、修复冲突    | 固定 SHA，提交前二次验证     |
| Webhook 重复投递 | 重复任务与重复评论    | 数据库唯一约束与幂等操作       |
| 仓库提示词注入      | Agent 越权或误操作 | 将仓库内容视为不可信数据、工具白名单 |
| 恶意构建脚本       | 读取数据、资源耗尽    | 临时隔离容器、低权限、网络和资源限制 |
| GitLab 暂时不可用 | 任务失败         | 超时、有限重试、任务恢复       |
| 模型 API 不稳定   | 审查延迟         | 请求预算、超时、可观测性       |
| SQLite 写入竞争  | 队列延迟或锁错误     | 单机低并发、WAL、事务与写入控制  |
| 镜像缓存膨胀       | 磁盘耗尽         | 清理策略、容量监控、配额       |
| 凭据泄露         | 仓库或代码被未授权修改  | 凭据分离、最小权限、脱敏和轮换    |

## 20. 后续扩展方向

在 MVP 稳定运行后，可以根据真实需求逐步增加以下能力：

### 20.1 审查规则体系

允许项目配置：

- 语言和框架约定。
- 安全规则。
- 性能和可维护性规则。
- 禁止使用的 API。
- 特定目录的审查重点。
- 测试与构建命令。

### 20.2 项目知识库

针对大型项目建立可更新的索引，以改善跨模块理解能力。知识库应与仓库提交版本关联，避免使用旧版本索引解释新提交。

### 20.3 更完善的修复工作流

后续可以增加：

- 修复前的计划与审批。
- 生成补丁供人工确认。
- 受控自动提交。
- 修复后自动运行 CI。
- 基于 CI 结果的有限次数修复。
- 修复失败时自动恢复工作区。

### 20.4 多 Worker 与多项目支持

当单 Worker 成为瓶颈时，可以增加并发 Worker。此时需要进一步设计任务租约、跨进程锁、队列恢复和数据库扩展方案。

### 20.5 多模型路由

根据任务类型选择模型：

- 简单问题使用低成本模型。
- 复杂逻辑分析使用更强的模型。
- 格式化、摘要和结构化处理使用专用模型。
- 对模型调用设置预算与降级策略。

### 20.6 更多代码平台

可以将 GitLab 特有逻辑封装在平台适配层，为未来支持 GitHub、Gitea 等平台保留接口。但第一阶段应优先把 GitLab 的版本管理、权限控制和评论流程做可靠，而不是同时支持多个平台。

## 21. 开源与项目治理建议

即使 Corvex 首先用于企业内部，也建议从一开始采用清晰的项目治理方式。

### 21.1 仓库文件

| 文件                            | 内容               |
| ----------------------------- | ---------------- |
| `README.md`                   | 英文项目主页、功能介绍、快速开始 |
| `README.zh_CN.md`             | 中文项目说明与部署指南      |
| `WHITEPAPER.md`               | 完整技术白皮书          |
| `LICENSE`                     | 项目许可证            |
| `SECURITY.md`                 | 漏洞报告与安全策略        |
| `CONTRIBUTING.md`             | 贡献指南             |
| `CHANGELOG.md`                | 版本变更记录           |
| `.env.example`                | 环境变量示例，不包含真实密钥   |
| `configs/config.example.yaml` | 配置文件模板           |

许可证应根据是否开源、是否允许商业使用以及是否计划提供企业版来决定，不建议在未确定项目治理目标时随意选择。

### 21.2 版本规划

可以采用以下版本路线：

| 版本       | 目标                           |
| -------- | ---------------------------- |
| `v0.1.0` | Webhook、指令解析、任务队列和状态查询       |
| `v0.2.0` | Git 镜像缓存、精确 SHA 检出和 Diff 上下文 |
| `v0.3.0` | AI 审查、结构化问题和行级评论             |
| `v0.4.0` | 隔离工作区、补丁生成和测试执行              |
| `v0.5.0` | 受控提交与推送、审计和故障恢复              |
| `v1.0.0` | 完成安全测试、可靠性测试和正式部署验收          |

以上版本号是建议的里程碑，不代表这些版本已经发布。

## 22. 最终技术决策

综合开发复杂度、部署成本、内部网络条件和后续扩展需求，建议第一版采用以下方案。

产品形态：Corvex

企业内部 GitLab 的 AI 代码审查与修复 Agent。

开发架构：Golang 模块化单体

一个代码仓库、一个二进制程序、Server 与 Worker 两种启动模式。

任务机制：Webhook + SQLite

事件驱动、持久化任务、幂等去重；初期不引入额外消息队列。

代码处理：Git 镜像 + 独立工作区

按项目 ID 缓存仓库，按 MR Head SHA 创建任务工作区。

模型接入：OpenAI 兼容接口

使用统一模型适配层，控制调用次数、超时和成本。

部署方式：Linux + Docker Compose

通过一次性脚本配置服务与 Webhook，保留持久化数据。

安全策略：默认只读、修复隔离、推送受控

模型不持有 GitLab 写入令牌，测试在受限环境执行，所有写操作经过服务端授权。

Corvex 的核心设计原则可以归纳为一句话：

> 让 AI 负责理解代码与提出修改，让 Go 服务负责权限、任务状态、版本一致性和执行控制。

这条边界决定了项目能否从一个简单的 AI 评论机器人，发展成可以长期运行的代码审查与修复系统。

建议真正开始编码时，首先完成 Webhook 接入、任务持久化、Git 精确版本检出和任务状态机。这四部分构成后续所有 AI 能力的基础。只有这条基础链路稳定之后，再引入模型审查和自动修复，才能避免把问题定位、权限控制和代码执行的复杂性混在一起。
