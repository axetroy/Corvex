# Corvex

Corvex 是基于单一 TypeScript 应用和 Pi SDK 构建的自托管 GitLab 代理。架构说明请参阅 [design.md](design.md)，使用文档请参阅[文档站点](https://axetroy.github.io/Corvex/)。

## 项目概览

Corvex 在运维控制台中运行持久化对话。每个对话绑定一个仓库分支和固定版本，并在 Server 进程内内联执行。

- 控制台可发现当前登录用户的 GitLab 令牌可访问的全部仓库，并把对话与轮次保存在 SQLite 中。
- 每一轮都有自己的轨迹、执行记录、流式回复与按请求记录的有界上下文快照；工作区包含上下文与轨迹检查器、只读 Git 图谱、文件浏览器与对话记录。
- 对话可以读取仓库与 GitLab，并在用户明确要求时通过受约束的工具执行 GitLab 写操作；Git 工具集限定在对话工作区与本地镜像内。
- 命令仅在开启执行环境后通过绑定到会话的 `run_command` 工具或技能的 `run_skill_command` 固定命令运行；技能附带的其它文件不会自动执行。
- Prometheus 指标与存储清理控制台用于运维。

Webhook 驱动的任务事件（审查、聊天、解释、修复、Issue 实现）不在当前阶段内，延期设计见 [ROADMAP.zh_CN.md](ROADMAP.zh_CN.md)。

从[快速开始](https://axetroy.github.io/Corvex/zh-CN/guide)入门，或查看[配置参考](https://axetroy.github.io/Corvex/zh-CN/configuration)、[架构说明](https://axetroy.github.io/Corvex/zh-CN/architecture)和[运行与运维](https://axetroy.github.io/Corvex/zh-CN/operations)。

## 快速开始

需要 Node.js 26.12.1 及 pnpm 12.4.1。从源码运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

在安装页面配置 GitLab OAuth，然后访问 `/ops` 登录并创建对话。Docker Compose、备份、保留策略与 TLS 见[运行与运维](https://axetroy.github.io/Corvex/zh-CN/operations)。

## 部署

Corvex 提供预构建的 `ghcr.io/axetroy/corvex` 镜像和仅包含单个 Server 服务的 Compose 部署。部署、存储与资源配置请参阅[运行与运维](https://axetroy.github.io/Corvex/zh-CN/operations)。

## 开发

```sh
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
```

Corvex 的所有 GitLab API 与 Git 网络操作都使用当前登录用户的 OAuth 令牌，没有共享的读/写令牌；GitLab 写操作仍需要用户明确要求。不可信代码不会被执行。
