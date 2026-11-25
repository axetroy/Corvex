# 可读终端设计（流式输出 + 随时停止）

本文规划 Corvex 执行环境的"可读终端"：当 Agent 调用 `run_command` 时，用户能在控制台**实时看到命令输出**，并能**随时停止该命令**。这是执行环境（见 `execution-design.md`）的观测与交互层，不改变执行的安全边界。

## 1. 目标与非目标

**目标**

- 命令执行期间，输出按产生顺序**流式**渲染到对话页，而不是等命令结束才一次性出现；
- 每个正在运行的命令都有**停止按钮**，点击立即终止该命令及其子进程；
- 刷新页面或重连后，能**回放**本轮已经产生的输出（不丢失历史）；
- UI 区分 stdout / stderr / 退出状态，长输出有上限，恶意输出按不可信数据处理。

**非目标**

- 不做交互式 shell（不能往命令里敲输入）——`run_command` 仍是一次性命令，stdin 为 ignore；
- 不提供多命令并发终端；每轮命令按模型调用顺序串行；
- 不改变沙箱/本地后端的安全边界；停止命令只是 kill 子进程，不涉及权限提升。

## 2. 现状与差距

现有能力：

- `run_command` 在执行完成后才把**完整结果**（stdout/stderr/exitCode/duration）作为工具结果返回并写入轨迹（`conversation_trace.trace_output`）；
- 对话 SSE（`.../turns/:turnId/stream`）已能推送 text / thinking / tool / context 事件，但**工具事件只有开始/结束状态**，没有命令输出的增量；
- 轮次级取消 `POST .../turns/:turnId/cancel` 会 abort 整个 turn，连带 kill 正在执行的命令——但这是"取消整轮"，不是"只停这条命令"。

差距：命令执行过程中**没有任何输出事件**；用户只能干等；停止意味着放弃整轮对话。

## 3. 数据流设计

### 3.1 事件模型

在 `ConversationStreamEvent` 增加一种命令输出事件（按调用 ID 归属到具体命令）：

```
| { type: "exec"; execId: string; stream: "stdout" | "stderr"; chunk: string; done?: boolean; exitCode?: number | null; aborted?: boolean; truncated?: boolean }
```

- `execId` = 工具调用 ID（SDK 的 toolCallId），一条命令一个；
- `chunk` 是**增量**文本（不是累计），前端按 execId 追加；
- `done: true` 带终态（exitCode / aborted / truncated），标志命令结束；
- 每段 chunk 在服务端已按 `redactSensitiveText` 脱敏、按总字节上限截断。

工具开始事件 `tool` 仍按现有语义推送（status=running），终端 UI 以它为命令标题；`exec` 事件负责填充输出区。

### 3.2 服务端链路

1. **后端支持流式回调**：`ExecutionBackend.run(request, signal, onChunk)` 增加可选 `onChunk(stream, text)`；
   - 本地后端：child.stdout/stderr 的 `data` 回调里，先把字节计入总预算（复用现有 `maxOutputBytes` 逻辑），再脱敏后调用 `onChunk`；超限置 `truncated`，后续 chunk 不再推送；
   - 沙箱后端：同样从容器 stdout/stderr 读取并回调；结果结构不变。
2. **PiAgent 桥接**：`createExecutionExtension` 拿到 `request.onExecDelta` 回调，在 `backend.run` 的 `onChunk` 里把 chunk 转成 `exec` 事件上抛；命令结束（`ExecutionResult`）时发 `done: true` 的终态事件。
3. **Runner 发布**：`ConversationRunner` 把 `onExecDelta` 接到 `publishStream(turnId, { type: "exec", ... })`，与其他流事件走同一订阅通道。
4. **SSE 路由**：现有 `.../stream` 路由无需改协议，新事件类型随同一 SSE 推送（`parseSseFrames` 增加 `exec` 分支）。
5. **离线回放**：命令输出已随工具结果落库到 `conversation_trace.trace_output`（完整 stdout/stderr，已脱敏限长）。历史回放时前端从过程快照的 `record_plan` 类似路径——更准确地说，从新增的 `GET .../turns/:turnId` 已返回的 trajectory 里读取该工具调用的 output，还原成终端行。这样刷新后仍能看到输出。

### 3.3 持久化与回放（P1 实现）

- 不新增数据库表：`collectProcess` 在轮次落库时，把 `exec` 事件按 execId 合并为完整 `stdout`/`stderr` 及终态，写入过程快照 `conversation_messages.process` 的工具条目 `execOutput` 字段。
- 回放：刷新后 `ConversationsPage` 从 `message.process` 的 `run_command` 条目重建 `ExecDisplay`，终端内容与流式期间一致；无需再请求轨迹接口。
- `streamSnapshots` 对同一 execId/stream 的连续 chunk 合并为一条，避免重连快照随高频输出膨胀（不影响实时订阅者按帧接收）。

## 4. 停止单条命令

### 4.1 API

新增 `POST /api/ops/conversations/:id/turns/:turnId/executions/:execId/cancel`：

- 校验会话归属与轮次存在；
- 在 `ConversationRunner` 维护 `Map<execId, AbortController>`（命令启动时注册、结束时清理）；
- 找到对应 controller 就 `abort()`，后端 kill 子进程（本地/沙箱现有 signal 处理已支持）；
- 返回 `{ cancelled: true }`；找不到返回 404/409（命令已结束）。

注意：这只 abort **该命令的子进程**，不 abort 整个 turn；模型会收到工具结果 `aborted: true`，由它决定下一步（通常应汇报"命令被用户停止"）。

### 4.2 前端交互

- 每个正在运行的终端行右侧有"停止"按钮，仅在 `status === "running"` 时可见；
- 点击调用上面的 API；按钮进入 loading；收到 `exec done aborted` 后变为"已停止"状态；
- 停止命令**不**替换 composer 的全局 Stop 按钮（那是取消整轮，语义不同）。

## 5. UI 组件

新增 `ConversationExecTerminal`（对话工作区 Chat 过程块内，紧随对应工具调用显示）：

- 单行终端样式：等宽字体、深色/浅色主题变量（`var(--bg-code)` / `var(--text)`）；
- 头部：`$ <command>` + 状态徽标（running / exit 0 / exit N / aborted / truncated）+ 停止按钮 + 耗时；
- 正文：滚动区，stdout 常规色、stderr 用 `--danger`/`--warning` 色；自动滚动到底，用户上翻时暂停跟随（复用 `isAtScrollBottom`）；
- 输出按字节上限渲染，超出显示"输出已截断"提示；
- 终端作为一个 disclosure（可折叠），默认运行中展开、结束后可收起。

i18n：命令头、状态文案、停止按钮、截断提示、回放提示，中英文各一组。

## 6. 分阶段落地

| 阶段 | 状态 | 内容 |
|---|---|---|
| P0 | **已完成** | 事件模型 `exec` + 后端 `onChunk` + PiAgent/Runner/SSE/stream.ts 全链路；`ConversationExecTerminal` 渲染流式输出与状态；单命令停止 API + 按钮（停止原因 `user manually stopped this command` 经 `signal.reason` → `ExecutionResult.reason` 进入工具结果，供模型决策） |
| P1 | **已完成** | `collectProcess` 把 exec 增量合并为完整输出写入过程快照 `execOutput`，刷新后由 `message.process` 还原终端；`streamSnapshots` 对连续 chunk 合并防膨胀 |
| P2 | 进行中 | 体验增强：输出搜索、复制、按命令过滤、大输出虚拟滚动 |

## 7. 测试策略

- 后端：本地/沙箱后端在 `onChunk` 下的增量回调、脱敏、上限截断、signal 取消；
- 链路：PiAgent mock 模型触发 `run_command`，断言 SSE 收到 `exec` 事件序列与终态；
- API：单命令 cancel 只 abort 对应 controller，不影响其他命令与整轮；
- UI：`parseSseFrames` 正确解析 `exec`；终端组件按 execId 追加、滚动跟随、停止按钮状态。

## 8. 安全与边界

- 所有命令输出按不可信数据处理：先脱敏再推送/落库，不绕过 `src/redact.ts`；
- 流式 chunk 与最终落库共用同一字节预算，防止通过高频输出绕过上限；
- 停止命令走与整轮取消相同的 `AbortSignal` 体系，子进程 kill 逻辑复用，不新增旁路；
- 前端终端只展示，不提供输入，避免变成交互式 shell。

## 9. P2 渲染方案：xterm.js（架构决策）

P2 采用 VS Code 同款的 **xterm.js**（`@xterm/xterm` 6.x）替换 P0 的手写 `<pre>` 输出区，配套 `@xterm/addon-search`（搜索高亮与逐个跳转）、`@xterm/addon-fit`（按容器自适应行列）。理由：

- **ANSI 原生渲染**：构建工具、`ls --color` 等命令会输出颜色与光标控制序列，手写 `<pre>` 只会把转义序列显示成乱码；xterm 正确解析这些序列；
- **虚拟滚动开箱即用**：xterm 的 viewport 只渲染可见行，长输出不会生成上万个 DOM 节点，直接满足 P2 的大输出性能目标；
- **搜索/复制内置**：搜索插件提供高亮与前后匹配跳转，选中即复制（另有"复制全部"按钮）；不需要自研文本遍历与高亮；
- **依赖面可控**：仅 3 个前端包，由 Vite 打包进独立的懒加载 chunk，不进入服务端运行时依赖集，不改变任何安全边界。

与 React 的衔接：终端实例是命令式的，组件持有 `Terminal` 并按 execId 记录"已写入长度"，输出增量到达时只 `write()` 新增部分；主题切换经 `MutationObserver` 更新 `term.options.theme`，容器尺寸变化经 `ResizeObserver` 触发 `fit()`；用户上翻时暂停自动跟随（xterm `onScroll` 的 `viewportY < baseY` 判定），回到底部恢复跟随。纯数据变换（`createExecDisplay`/`applyExecDelta`）抽到不依赖 React/xterm 的模块，便于单测。
