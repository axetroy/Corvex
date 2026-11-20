import type { ServerResponse } from "node:http";
import type { CorvexConfig } from "../../config/config.js";
import type { EventStore } from "../../events/store.js";
import type { GitLabClient } from "../../gitlab/client.js";
import type { ConversationRunner } from "../conversation-runner.js";
import type { EventRunner } from "../event-runner.js";
import type { SettingsService } from "../settings-service.js";

/**
 * `/api/ops` 路由所需的运行时依赖。Server 只暴露路由真正需要的能力，
 * 这样路由模块不必依赖 `CorvexServer` 的内部实现。
 */
export interface OpsContext {
  readonly config: CorvexConfig;
  readonly store: EventStore;
  readonly gitlab: GitLabClient;
  readonly conversations: ConversationRunner;
  /** 内联事件执行器；`agent.enabled=false` 时为 undefined。 */
  readonly events?: EventRunner;
  readonly settings: SettingsService;
  /** 正在推送的对话流连接；Server 关闭时统一结束，避免拖住 `close()`。 */
  readonly conversationStreams: Set<ServerResponse>;
  /** 在 Server 进程内联启动一轮对话。 */
  startConversationTurn(turnId: string): void;
}
