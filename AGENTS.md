# AGENTS.md

面向本仓库编码代理的准则。改动架构前先读 `design.md`，涉及命令执行读 `execution-design.md` 和 `terminal-design.md`，分代理计划见 `subagent-design.md`，计划任务实现见 `scheduled-tasks-design.md`，外部文件附件规划见 `file-attachments-design.md`。这些文档是契约，本文件只保留日常约定。

## 项目

Corvex 是自托管的 GitLab 协作 Agent，单进程 `server` 模式：Fastify 提供运维台和 API，`ConversationRunner` 内联执行对话轮次，状态存 SQLite（`node:sqlite`），代码存 Git 镜像与每会话 worktree。模型循环、工具、Skill 由 Pi SDK 驱动；授权、校验、状态与 GitLab 写入由 Corvex 负责。

## 环境与命令

- Node 26.12.1 / pnpm 12.4.1；用 `pnpm install --frozen-lockfile`，不要手改 `pnpm-lock.yaml` 或换包管理器。
- `git` 必须在 PATH；SQLite 只用内置 `node:sqlite`，不要引入数据库驱动、ORM 或查询构造器。
- 常用：`pnpm run build` / `typecheck` / `lint` / `test`；单文件用 `pnpm vitest run test/unit/xxx.test.ts`，按名用 `-t`。`pnpm dev` 本地启动。
- 提交前跑 lint、typecheck、test。CI 覆盖 Ubuntu/macOS/Windows，路径与文件处理要跨平台。

## 目录

```text
src/cli.ts         CLI 入口（init / backup / storage / server / check-config）
src/config/        YAML 加载、按角色校验、运行时设置
src/app/           HTTP 生命周期、内联对话 Runner、运维台
src/app/http/      Fastify 路由、鉴权、响应封装、静态资源
src/app/ui/        React 运维台入口（App.tsx / main.tsx 与构建配置）
src/app/ui/pages/  有路由的页面（对话、设置、安装、落地页、管理后台各页）
src/app/ui/components/  无路由的可复用 UI 组件
src/app/ui/lib/    纯公共库：api、i18n、routing、格式化、主题、类型等
src/store.ts       SQLite schema/迁移、存储与轨迹
src/model.ts       共享领域类型
src/gitlab/        GitLab REST 客户端
src/git/           镜像、worktree、提交图谱、路径守卫、patch
src/agent/         Pi session、提示词、受限工具与执行后端
test/unit/         单元测试；test/fixtures/ 为 CI 配置样本
```

## 编码约定

- ESM + NodeNext：相对导入即使来自 `.ts` 也带 `.js` 后缀；类型用 `import type`。
- TypeScript `strict`：避免 `any`；YAML、HTTP body、GitLab 响应、模型输出、SQLite 行等外部数据在边界校验并用类型守卫收窄。
- 优先 Node 内置模块与标准 `fetch`。HTTP 层是 Fastify，改路由时保持现有状态码、响应体、头、auth realm 与日志键不变。新增运行时依赖属于架构决策，先在 `design.md` 论证。
- 源码注释和 JSDoc 用中文且保持真实；标识符与用户可见日志键用英文。
- 用户可见文案跟随 `agent.response_language`（`en` / `zh-CN`）。文档双语：`docs/<page>.md` 与 `docs/zh-CN/<page>.md`、`README.md` 与 `README.zh_CN.md`；行为、配置或运维变化要同步两种语言。
- 禁止在代码、配置、fixture、日志、提示词或轨迹中写密钥。轨迹、摘要、上下文快照必须走 `src/redact.ts` 的脱敏与大小上限，不要绕过。

## 运维台 UI

- 目录归属：有路由的页面放 `pages/`，无路由的可复用组件放 `components/`，纯工具、类型和常量放 `lib/`；不要在 `components/` 里留带路由的页面，也不要在 `ui/` 根目录新增工具文件。
- Ant Design v6；颜色只用 `theme.css` 里的主题变量，不写死 hex，亮色和暗色都要跟随。
- antd 运行时样式带三个 class 选择器，覆盖时至少用四个 class；portal 到 `body` 的弹层要传 `classNames.popup.root` 并声明自己的变量。
- 管理中心表格配色的唯一坐标是「Git 存储清理」列表（`.settings-cleanup-list li`，定义在 `SettingsPage.css`）：条目与表头背景 `--bg-subtle`、文字 `--text-secondary` / 12px、边框 `--border-soft`、hover `--bg-hover`、目录代码 `--primary`。统一在 `AdminConsole.css` 用 `.admin-console .admin-console-main .ant-table …` 实现，新增的管理中心表格自动继承；不要在存储、设置等页面另写表格配色。
- 页面有 nonce CSP：禁止静态 `Modal.confirm` / `message.*` / `notification.*`，改用 `Modal.useModal()` 或 `App.useApp()` 并把 contextHolder 渲染在页面内；动态 `<style>` 由 `src/app/ui/csp.ts` 盖章。
- 布局：`.app-shell` 左侧栏 + 主内容区；会话列表在左栏；工作区用 `react-resizable-panels`，不要手写拖拽；布局状态存 `localStorage`。
- 设置项 key 必须与 `runtimeSettingDefinitions` 完全一致（有测试校验）。运行时设置存 SQLite，配置文件只提供初始值。
- 运行中执行中的插话属于当前轮次：带 `kind='interjection'` 的用户消息不生成顶层气泡，而是作为一段 `interjection` 过程条目插进该轮次时间线（实时 SSE 与刷新后的快照都要有）；历史插话由迁移按时间回填。
- 会话头部的「N 个变更文件」标签点击后切到「变更」标签；变更列表支持逐文件撤销，后端以会话 ref 的父提交为基线重建，只移除该文件，不留下反向 diff，且运行中轮次禁止撤销。
- 仓库搜索：GitLab 的 `search` 对 1-2 字符短词只返回同名项目，短词改为分页拉取可见项目后本地子串过滤；分页按 4 路并发拉取而非逐页串行。候选集在服务端按「相似度（主导）+ `last_activity_at` 活跃度 + 最近会话」综合排序，归档项目降级；排序纯函数放在 `src/app/http/ops/project-ranking.ts`，路由只负责取候选、排序和按页切片。
- 会话文件浏览只从当前 worktree 读取（`LocalFileSource`），不再回退到 GitLab 快照；worktree 被回收时返回 409 并提示先发起一轮对话。

## 架构与安全不变量（不要为省事削弱）

- 授权在 Corvex 代码里：OAuth2 登录、按用户 GitLab token、请求体限制、工具绑定会话项目与 worktree。用户请求即范围内工作的授权，不做逐步审批。
- 每轮 pin 分支 head SHA，准备 worktree 与 GitLab 写入前复核；过期轮次以 `stale` 结束，不允许部分写入。
- Pi session 只拿本轮需要的工具：没有内置 `bash` / `edit` / `write`；自定义工具自己限制路径和字节；Skill 只是指令，不是访问控制，Skill 脚本永不执行。
- Agent 输出不可信：GitLab 写工具绑定会话项目并标注不可逆动作；写前复核目标、revision 和取消信号。
- `run_command` 仅在 `execution.enabled` 时按轮注册，并限制在配置的后端与 worktree 内；换执行器需要单独的沙箱和授权设计。
- 子模块只读：只检出树中 gitlink 对应的 commit，URL 必须同源或管理员显式放行；用户 OAuth token 只发往配置 GitLab，第三方 host 只能用匿名或专用 token，禁止跟随重定向。fs-write 拒绝子模块路径，因为改动不会进入会话 ref。
- 轮次状态机在 `AppStore` 强制执行（`queued → running → completed`，另有 `failed` / `stale` / `cancelled`）；失败不自动重试，因为 GitLab 写入结果可能不确定。
- 配置按角色校验；启动不需要 GitLab 凭据，因为 API 与 Git 调用都用登录用户 token。
- 分支/ref 名称允许 Unicode（含中文），统一用 `src/git/refs.ts` 的 `isValidBranchName` / `branchNamePatternSource`，工具 schema 与运行时校验共用；不要在各处写死 ASCII 正则，否则中文分支会「工具放行、执行拒绝」。
- 轮末自动保存改动用的是占位提交信息；用户/模型显式给出提交信息时，`GitManager` 只重写仍带占位信息的会话 ref 提交再推送，不能改写真实提交或已发布提交。

## 测试

Vitest 限定 `test/**`，避免扫描 `data/` 下的第三方文件；单测放在 `test/unit/<module>.test.ts`，运维台脚本用 `ui-*.test.ts`。测试要 hermetic：无外网、不依赖开发机状态、清理临时目录、`afterEach` 停掉运行中的循环。行为变更要补测试，包含失败路径。

## 提交与 PR

使用 Conventional Commit（`feat:` / `fix:` / `docs:` / `chore:` 及 scoped 形式），标题中英文均可；一个逻辑改动一个提交，只 stage 相关文件，不要提交 `.env`、本地数据库或 `data/`。CI 跑 lint、typecheck、test、build 和 Docker smoke；tag 推送会触发发版，不要在功能分支打 tag 或创建 release。
