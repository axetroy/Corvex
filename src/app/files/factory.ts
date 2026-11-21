import type { GitLabClient } from "../../gitlab/client.js";
import { GitLabFileSource } from "./gitlab-source.js";
import type { ConversationFileSource } from "./source.js";

export interface FileSourceOptions {
  /** 未来接入磁盘等实现时按 kind 分派；目前仅 GitLab。 */
  kind: "gitlab";
  gitlab: GitLabClient;
  projectId: number;
  sha: string;
}

/** 会话文件源工厂：UI 与路由只依赖 ConversationFileSource，替换实现不影响调用方。 */
export function createConversationFileSource(options: FileSourceOptions): ConversationFileSource {
  switch (options.kind) {
    case "gitlab":
      return new GitLabFileSource(options.gitlab, options.projectId, options.sha);
    default: {
      const exhaustive: never = options.kind;
      throw new Error(`unsupported file source: ${String(exhaustive)}`);
    }
  }
}
