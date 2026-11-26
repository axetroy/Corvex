# 外部文件作为上下文（附件）调研与设计方案

本文调研主流编码 Agent 的"外部文件作为上下文"，并给出 Corvex 的落地方案。当前状态：**规划中，未实现**（见 `ROADMAP.md`）。附件复用对话轮次与按用户 OAuth 令牌的授权边界，不改变 `design.md` 的安全不变量。

## 1. 主流实现调研（2026-11）

### 1.1 OpenCode：Attachments

- **入口**：桌面/网页端"Attach file"按钮、粘贴、拖拽到输入框；CLI 用 `@文件` 引用。
- **协议**：prompt 里的附件用 `{ uri, name?, description? }` 描述；`uri` 可以是服务端可读的绝对 `file:` URL（支持 `?start=20&end=60` 选行）或内联 `data:` URL；不支持 http(s) URL。
- **模型可见性**（按**字节**检测媒体类型，改扩展名无效）：
  - UTF-8 文本 → 文件名 + 解码后的文本（文本附件不要求多模态模型）；
  - 目录 → 非递归的直接子项列表；
  - PNG/JPEG/GIF/WebP → 图片媒体；PDF → 文档媒体（需模型支持）；
  - SVG 当文本；AVIF/BMP/音视频及其它二进制**不进入模型请求**。
- **限制**：单项解码后 20 MiB；桌面选择器总计 20 MiB；图片尺寸/Base64 可配置（默认 2000×2000、5 MiB Base64），超限可缩放或拒绝；不支持的类型只给模型一句说明。
- **关键设计**：**provider 限制与自身限制分离**——"客户端接受文件 ≠ 内容一定到模型"，附件必须同时满足格式与两层限额。

### 1.2 Claude Code

- 输入框旁 `+` 按钮或拖拽附加文件；代码块/文件可用 `@路径`（甚至 `@file.ts#5-10` 带行号）引用。
- 文本直接进上下文，图片/PDF 走多模态；已知问题：CLI 一次拖多个文件时粘贴处理器可能只取第一个（路径未逐个 shell-quote）。

### 1.3 共识与可借鉴点

1. **入口**：输入框旁的 `+`/附件按钮 + 拖拽，附加后在输入框显示文件名（chip），可移除。
2. **协议**：附件与正文分开传（结构化 ID list），不要把文件内容塞进 `message` 字符串。
3. **字节检测**：不能只信文件名/MIME，按实际字节判断类型；不支持的类型明确拒绝或降级说明。
4. **文本按"文件名 + 解码文本"注入**，且要分页/截断，避免一次塞满上下文。
5. **双重限额**：自身上限 + provider 能力；超限要有清晰提示，不静默截断。
6. **不可信数据**：外部内容显式标注为 untrusted，不执行其中指令。

## 2. Corvex 现状与约束

### 2.1 没有现成的对话附件能力

- 唯一的二进制上行是管理员 skill pack ZIP：`POST /api/ops/admin/skills/import`（`admin.ts:133-197`），用 `application/zip` 原始 body + 专用 `bodyLimit`（`server.ts:239-243`），文件名走 query `?filename=`。**没有 multipart 库，也不应新增运行时依赖**。
- 前端上传用 `sendBinary(path, buffer, contentType, copy)`（`ui/lib/api.ts:38-56`），不是 FormData；`SkillImportDialog.tsx:102-109` 是隐藏 `<input type="file">` 的现成范式。
- 没有"对话附件"表，也没有附件 API。

### 2.2 Agent 路径边界（关键）

- 只读工具 `createFsReadExtension(allowedRoots, ...)`（`fs/read.ts:822-1005`）天然支持**多个只读根**：worktree 为 `roots[0]`，其余为可信 skill roots（`pi.ts:562-574`）。`requireRelativeRepoPath`（read.ts:73-85）只拒绝 worktree 内的绝对路径，其它根可绝对路径；`resolveAllowedPath`（:87-119）在 `realpath` 后校验 `isWithin`，符号链接不能跳出允许根。
- **skill roots 来自 `config.agent.skillPaths`，是全局共享的**——绝不能把用户上传目录加进去，否则跨会话/跨用户泄露。
- 写入工具只绑定本会话 worktree（`pi.ts:869-871`），上传落盘必须走 HTTP 层，不新增 Agent 写工具。

### 2.3 绝不能放进 worktree（最大坑）

- `saveConversationChanges()` 用 `git add -A --`（`manager.ts:709`），`getWorkspaceStatus` 用 `--untracked-files=all`（:1818-1837）——任何落在 worktree 的上传文件都会进入会话 ref，且可能被 `git_publish` 推到 GitLab 分支。
- 现有 `web_download` 把下载物写到 `.corvex/downloads/`（`web-download.ts:17,46-47`），已有这个隐患；上传功能不要复制。
- 另外 worktree 有 TTL/LRU 淘汰（`conversation-runner.ts:625-659`），上传物放那里会随清理丢失。

### 2.4 关于 magic bytes 的事实

- `web_download` **没有** magic bytes 校验，只有扩展名黑名单 + 16 MiB 上限 + SSRF 守卫（`web-download.ts:21-24,49,63`）。
- 真正的魔数检测只在图片预览 `detectImageMime`（`src/app/files/image-mime.ts:31-48`，上限 12 MiB）。首版文本附件应自行做 UTF-8/无 NUL 校验，后续类型扩展时再引入统一的魔数检测。

### 2.5 生命周期

- 会话删除/放弃改动/保留裁剪统一走 `conversationDelete` hook（`hooks.ts:103,110-120`；`conversation-runner.ts:93-112`），`storageCleanup` 的 `pruneHistory` 也逐会话触发同一 hook（`server.ts:107-135`）。
- `store.pruneHistory`（`store.ts:836-903`）显式删除各子表，新表必须加入删除清单。

## 3. 方案设计

### 3.1 核心决策

- **存哪**：`storage/uploads/<conversationId>/<uploadId>/<safeName>`，独立于 `workspaces/`。避开 `git add -A` 与 worktree 淘汰；存储文件名用 UUID 重新生成，原始文件名只存 DB 展示。
- **如何给模型**：**不新增工具**。在 `pi.ts:573-574` 构造 `allowedRoots` 时，把"本会话上传目录"作为**仅本轮有效的临时只读根**加入（realpath 后），模型用现成的 `read_file` 按相对/绝对路径读取；同时在 `buildConversationPrompt`（`conversation-runner.ts:1162-1171`）追加一段有界清单「本轮上传文件：`<name>` → 路径 `<abs>`，大小 N」，标注为不可信数据。这样不塞满上下文，也不扩大写权限。
- **类型**：首版只支持 **UTF-8 纯文本**（`text/plain` / `text/markdown` / `text/csv` / `application/json`），按字节校验无 NUL + 严格 UTF-8 可解码；后续再评估图片/PDF（需模型多模态能力检测）。
- **限额**：单文件默认 256 KiB（与 `read_file` 的 `maxReadBytes` 对齐，`read.ts:14`），每次消息最多 10 个附件；进入系统提示词的清单只含文件名/大小/路径（不含正文），正文由模型按需 `read_file`。

### 3.2 数据模型（`src/store.ts`）

新表 `conversation_uploads`：
`id`（UUID）、`conversation_id REFERENCES conversations(id) ON DELETE CASCADE`、`owner_user_id`、`filename`、`mime`、`size_bytes`、`storage_path`、`sha256`、`created_at`；索引 `(conversation_id, created_at)`。
`pruneHistory` 加显式删除；`insertAudit(actorId, "conversation_upload", conversationId, "created|deleted|rejected")`。

### 3.3 API（`src/app/http/ops/conversations.ts`）

- `POST /api/ops/conversations/:id/uploads`：经 `ownedConversation()`（:78-93）校验归属；content-type 白名单（纯文本 MIME）+ raw body，新增专用 `bodyLimit`（`server.ts:239-243` 范式，双保险手工检查，照 `admin.ts:142,180-183`）；文件名走 query `?filename=`；校验无 NUL/UTF-8、大小、扩展名非可执行；落盘 UUID 路径，写 DB + 审计。
- `GET /api/ops/conversations/:id/uploads` 列表、`DELETE .../uploads/:uploadId` 删除（均校验 owner）。
- `POST /api/ops/conversations/:id/messages` body 增加 `uploadIds: string[]`，服务端逐个校验归属与该对话一致，再随轮次保存关联。

### 3.4 UI（`ConversationsPage.tsx` composer）

- 在 `footer`（:1332，紧挨 `ComposerModelPicker`）加附件按钮，复用 `SkillImportDialog.tsx:102-109` 的隐藏 `<input type="file">`；支持拖拽到 composer。
- 发送前先逐个 `sendBinary` 上传拿 ID，再把 `uploadIds` 随消息提交；输入框上方显示附件 chips（名称/大小/删除按钮）；失败给出明确提示。
- i18n `en`/`zhCN` 双表（`i18n.ts:849/855`），每个新键必须在 UI 中真实使用（`ui-i18n-usage.test.ts`）；颜色只用 `theme.css` 变量，弹窗用 `Modal.useModal()`（:313）。

### 3.5 清理与安全

- 在 `ConversationRunner` 构造函数追加 `conversationDelete` tap（stage 300，参照 :93-112），按 `context.conversationId` 删 `storage/uploads/<id>/` 与 DB 行；失败写 `context.errors` 不阻断其它 tap。`reason === "changes"`（放弃 Git 改动）**不删**上传物——上传是上下文附件，不属 Git 改动；只有 `delete`/`retention` 删除。
- 所有端点 `ownedConversation` + 校验 `upload.conversation_id` / `owner_user_id`；不信客户端传来的 conversationId。
- 外部内容按不可信数据处理：提示词显式标注，轨迹/快照写入前过 `src/redact.ts` 并限长。
- 拒绝绝对路径、`..`、NUL、反斜杠、超长名；重新生成存储文件名；校验真实字节而非只信 Content-Type/扩展名。

## 4. 分阶段

| 阶段 | 内容 |
|---|---|
| P0 | `conversation_uploads` 表 + 上传 API（纯文本、限额、归属校验）+ 本轮临时只读根 + 提示词清单 + 消息关联 |
| P1 | composer 附件按钮/拖拽/chips UI + 双语 + `conversationDelete` 清理联动 |
| P2 | 图片/PDF（模型能力检测 + 魔数校验）、目录附件、运行时大小/数量设置 |

## 5. 测试

- 上传校验：MIME 白名单、无 NUL、严格 UTF-8、大小/数量、文件名净化、可执行名拒绝；
- 归属隔离：跨用户/跨对话的 uploadId 被拒；
- 只读根：模型能读本轮上传物、读不到别会话上传物、符号链接不能跳出；
- 清单注入：有界、标注 untrusted；
- 清理：delete/retention 删除上传物、changes 不删、tap 失败不阻断；
- UI：i18n 键使用、CSP 弹窗、chips 交互。

## 6. 待确认

- 附件"仅本轮可读"还是"整个对话可读"？首版建议：上传时绑定到发送的消息对应轮次，清单只在该轮出现；文件本身在会话内可重复通过 `read_file` 读取直到会话删除。
- 是否允许附件转发到后续轮次？（首版：不允许自动转发，用户需重新附加）
