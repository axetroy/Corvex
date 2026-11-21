import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitLabConversationExtension } from "../../src/agent/gitlab-conversation.ts";
import type { GitLabConversationTools } from "../../src/agent/gitlab-conversation.ts";

type RegisteredTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

function collectTools(tools: GitLabConversationTools): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => registered.push(tool),
  } as unknown as ExtensionAPI;
  createGitLabConversationExtension(tools)(pi);
  return registered;
}

function fakeTools(): GitLabConversationTools {
  return {
    projectId: 7,
    getProject: vi.fn(async () => ({ id: 7 })),
    listIssues: vi.fn(async () => [{ iid: 1, title: "Issue", state: "opened" }]),
    listMergeRequests: vi.fn(async () => [{ iid: 2, title: "MR", state: "opened", sourceBranch: "feat", targetBranch: "main" }]),
    getIssue: vi.fn(async () => ({ iid: 1 })),
    getMergeRequest: vi.fn(async () => ({ iid: 2 })),
    getMergeRequestChanges: vi.fn(async () => ({ changes: [], truncated: false })),
    getIssueComments: vi.fn(async () => []),
    getMergeRequestComments: vi.fn(async () => []),
    getMergeRequestCommits: vi.fn(async () => ({ commits: [], page: 1, perPage: 10, hasMore: false, nextPage: null })),
    postIssueNote: vi.fn(async () => ({})),
    postMergeRequestNote: vi.fn(async () => ({})),
    updateMergeRequest: vi.fn(async () => ({})),
    updateIssue: vi.fn(async () => ({})),
  };
}

describe("GitLab conversation tools", () => {
  it("registers discovery and MR change tools alongside the existing ones", () => {
    const names = collectTools(fakeTools()).map((tool) => tool.name);
    expect(names).toContain("list_issues");
    expect(names).toContain("list_merge_requests");
    expect(names).toContain("get_merge_request_changes");
    expect(names).toContain("get_issue");
    expect(names).toContain("get_merge_request");
  });

  it("passes discovery filters through to the bound client", async () => {
    const tools = fakeTools();
    const registered = collectTools(tools);
    const listIssues = registered.find((tool) => tool.name === "list_issues")!;
    await listIssues.execute("call-1", { search: "parser", state: "all", page: 2, per_page: 10 });
    expect(tools.listIssues).toHaveBeenCalledWith({
      search: "parser", state: "all", page: 2, perPage: 10,
    });

    const changes = registered.find((tool) => tool.name === "get_merge_request_changes")!;
    await changes.execute("call-2", { mr_iid: 2 });
    expect(tools.getMergeRequestChanges).toHaveBeenCalledWith(2);
  });
});
