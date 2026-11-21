import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitLabExtension } from "../../src/agent/gitlab/index.ts";
import type { GitLabAgentTools } from "../../src/agent/gitlab/common.ts";

type RegisteredTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

function collectTools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const pi = { registerTool: (tool: RegisteredTool) => registered.push(tool) } as unknown as ExtensionAPI;
  createGitLabExtension(fakeTools())(pi);
  return registered;
}

function fakeTools(): GitLabAgentTools {
  const receipt = { status: 200, resourceId: 1 };
  return {
    getProject: vi.fn(async () => ({ id: 7 })),
    listIssues: vi.fn(async () => [{ iid: 1, title: "Issue", state: "opened" }]),
    listMergeRequests: vi.fn(async () => [{ iid: 2, title: "MR", state: "opened", sourceBranch: "feat", targetBranch: "main" }]),
    getIssue: vi.fn(async () => ({ iid: 1 })),
    getMergeRequest: vi.fn(async () => ({ iid: 2 })),
    getMergeRequestChanges: vi.fn(async () => ({ changes: [], truncated: false })),
    getIssueComments: vi.fn(async () => []),
    getMergeRequestComments: vi.fn(async () => []),
    getMergeRequestCommits: vi.fn(async () => ({ commits: [], page: 1, perPage: 10, hasMore: false, nextPage: null })),
    createIssue: vi.fn(async () => ({ iid: 3, webUrl: "http://gitlab.test/i/3" })),
    updateIssue: vi.fn(async () => receipt),
    deleteIssue: vi.fn(async () => receipt),
    postIssueNote: vi.fn(async () => receipt),
    updateIssueNote: vi.fn(async () => receipt),
    deleteIssueNote: vi.fn(async () => receipt),
    createMergeRequest: vi.fn(async () => ({ iid: 4, webUrl: "http://gitlab.test/mr/4", sourceBranch: "feat", targetBranch: "main" })),
    updateMergeRequest: vi.fn(async () => receipt),
    deleteMergeRequest: vi.fn(async () => receipt),
    mergeMergeRequest: vi.fn(async () => receipt),
    approveMergeRequest: vi.fn(async () => receipt),
    unapproveMergeRequest: vi.fn(async () => receipt),
    postMergeRequestNote: vi.fn(async () => receipt),
    updateMergeRequestNote: vi.fn(async () => receipt),
    deleteMergeRequestNote: vi.fn(async () => receipt),
    listMergeRequestDiscussions: vi.fn(async () => ({ discussions: [], truncated: false })),
    resolveDiscussion: vi.fn(async () => receipt),
  };
}

describe("GitLab issue and merge request tools", () => {
  it("registers the full issue and MR tool sets", () => {
    const names = collectTools().map((tool) => tool.name);
    for (const name of [
      "get_project_info", "list_issues", "get_issue", "create_issue", "update_issue",
      "close_issue", "reopen_issue", "delete_issue", "get_issue_comments",
      "post_issue_note", "update_issue_note", "delete_issue_note",
      "list_merge_requests", "get_merge_request", "create_merge_request", "update_merge_request",
      "close_merge_request", "reopen_merge_request", "merge_merge_request", "delete_merge_request",
      "approve_merge_request", "unapprove_merge_request", "get_merge_request_changes",
      "get_merge_request_commits", "get_merge_request_comments", "list_merge_request_discussions",
      "resolve_merge_request_discussion", "post_mr_note", "update_mr_note", "delete_mr_note",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("passes discovery filters and bounded reads through to the bound client", async () => {
    const tools = fakeTools();
    const pi = { registerTool: (tool: RegisteredTool) => registered.push(tool) } as unknown as ExtensionAPI;
    const registered: RegisteredTool[] = [];
    createGitLabExtension(tools)(pi);
    const listIssues = registered.find((tool) => tool.name === "list_issues")!;
    await listIssues.execute("call-1", { search: "parser", state: "all", page: 2, per_page: 10 });
    expect(tools.listIssues).toHaveBeenCalledWith({ search: "parser", state: "all", page: 2, perPage: 10 });

    const changes = registered.find((tool) => tool.name === "get_merge_request_changes")!;
    await changes.execute("call-2", { mr_iid: 2 });
    expect(tools.getMergeRequestChanges).toHaveBeenCalledWith(2);
  });

  it("builds create inputs and destructive action options", async () => {
    const tools = fakeTools();
    const registered: RegisteredTool[] = [];
    const pi = { registerTool: (tool: RegisteredTool) => registered.push(tool) } as unknown as ExtensionAPI;
    createGitLabExtension(tools)(pi);
    const find = (name: string) => registered.find((tool) => tool.name === name)!;

    await find("create_issue").execute("c1", {
      title: "Bug", description: "details", labels: ["bug", "p1"], assignee_ids: [5], milestone_id: 9, confidential: true,
    });
    expect(tools.createIssue).toHaveBeenCalledWith({
      title: "Bug", description: "details", labels: ["bug", "p1"], assigneeIds: [5], milestoneId: 9, confidential: true,
    });

    await find("create_merge_request").execute("c2", {
      title: "Feature", description: "d", source_branch: "feat", target_branch: "main", draft: true, squash: true,
    });
    expect(tools.createMergeRequest).toHaveBeenCalledWith({
      title: "Feature", description: "d", sourceBranch: "feat", targetBranch: "main", draft: true, squash: true,
    });

    await find("merge_merge_request").execute("c3", { mr_iid: 2, squash: true, should_remove_source_branch: false });
    expect(tools.mergeMergeRequest).toHaveBeenCalledWith(2, { squash: true, shouldRemoveSourceBranch: false });

    await find("update_mr_note").execute("c4", { mr_iid: 2, note_id: 12, body: "edit" });
    expect(tools.updateMergeRequestNote).toHaveBeenCalledWith(2, 12, "edit");

    await find("resolve_merge_request_discussion").execute("c5", { mr_iid: 2, discussion_id: "abc", resolve: true });
    expect(tools.resolveDiscussion).toHaveBeenCalledWith(2, "abc", true);
  });
});
