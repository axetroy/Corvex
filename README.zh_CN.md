# Corvex

Corvex 是基于单一 TypeScript 应用和 Pi SDK 构建的自托管 GitLab 代码审查与修复代理。架构说明请参阅 [design.md](design.md)，使用文档请参阅[文档站点](https://axetroy.github.io/Corvex/)。

## 项目概览

Corvex 接收 GitLab Note Hook，将任务写入 SQLite，并由独立 Worker 执行。它支持 MR 审查、聊天、解释和修复提案，以及可回复或提出实现方案的 Issue 助手。

- 运维控制台可发现只读令牌可访问的全部仓库；Webhook 指令可通过可选用户阻止列表限制。
- 审查针对固定 MR 版本执行，并以行级讨论发布经过校验的问题。
- Fix 提案供人工应用。Issue 回复不会写代码；Issue 实现默认关闭，由 `issue.implement_enabled` 单独控制。
- Issue 实现默认使用项目默认分支，除非当前请求明确指定另一个已存在的分支；只会创建 Draft MR，不会自动合并。
- Worker 不执行仓库脚本或测试；SQLite 持久化任务和生命周期事件。
- 可选的只读运维控制台和 Prometheus 指标用于监控。

从[快速开始](https://axetroy.github.io/Corvex/zh-CN/guide)入门，或查看[配置参考](https://axetroy.github.io/Corvex/zh-CN/configuration)、[架构说明](https://axetroy.github.io/Corvex/zh-CN/architecture)和[运行与运维](https://axetroy.github.io/Corvex/zh-CN/operations)。

## 快速开始

需要 Node.js 26.12.1 及 pnpm 12.4.1。从源码运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

在生成的 YAML 中填写 GitLab URL，通过环境变量提供密钥，并为运维控制台配置只读令牌以发现可访问的全部仓库。然后按[快速开始指南](https://axetroy.github.io/Corvex/zh-CN/guide)注册 Note Hook 并启动 Server/可选 Worker。Docker Compose、备份、保留策略、TLS 和持久会话见[运行与运维](https://axetroy.github.io/Corvex/zh-CN/operations)。
## 部署

Corvex 提供预构建的 `ghcr.io/axetroy/corvex` 镜像和包含 Server/可选 Worker 的 Compose 部署。部署、Webhook 注册、存储和资源配置请参阅[运行与运维](https://axetroy.github.io/Corvex/zh-CN/operations)。

## 开发

```sh
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
```

显式运行带标注的审查基准（会调用配置的模型）：

```sh
pnpm run benchmark:review -- --config configs/config.yaml --min-f1 0.6
```

Worker 使用 GitLab 只读令牌读取 API/仓库，并使用写令牌发布内容；不可信代码不会被执行。
