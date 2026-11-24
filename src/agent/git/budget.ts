import type { GitToolAdapter } from "./common.js";

/** 单轮对话里 Git 工具调用的默认上限，超过后强制模型汇报而不是继续试错。 */
export const DEFAULT_GIT_TOOL_CALL_LIMIT = 40;

/** 预算耗尽时抛出的错误：工具层会把它作为工具失败返回给模型。 */
export class GitToolBudgetExceededError extends Error {
  constructor(readonly limit: number) {
    super(
      `Git operation budget exhausted: at most ${limit} Git tool calls are allowed in one turn. ` +
      "Stop calling Git tools now and report the current state to the user (what changed, what was published, and what remains). " +
      "Do not retry Git operations in this turn; failed attempts count toward this budget as well.",
    );
    this.name = "GitToolBudgetExceededError";
  }
}

/**
 * 给 Git 工具适配器加单轮调用预算。所有方法共用同一个计数器，成功与失败的调用都计入，
 * 这样「push 失败 → pull 失败 → merge 失败」的循环会被及时截断。limit < 1 表示不限制。
 */
export function withGitToolBudget(adapter: GitToolAdapter, limit: number): GitToolAdapter {
  if (!Number.isSafeInteger(limit) || limit < 1) return adapter;
  let used = 0;
  const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>): ((...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (used >= limit) throw new GitToolBudgetExceededError(limit);
      used += 1;
      return fn(...args);
    };
  return {
    status: guard(adapter.status.bind(adapter)),
    log: guard(adapter.log.bind(adapter)),
    show: guard(adapter.show.bind(adapter)),
    diff: guard(adapter.diff.bind(adapter)),
    clone: guard(adapter.clone.bind(adapter)),
    branches: guard(adapter.branches.bind(adapter)),
    createBranch: guard(adapter.createBranch.bind(adapter)),
    switchBranch: guard(adapter.switchBranch.bind(adapter)),
    checkout: guard(adapter.checkout.bind(adapter)),
    pull: guard(adapter.pull.bind(adapter)),
    sync: guard(adapter.sync.bind(adapter)),
    merge: guard(adapter.merge.bind(adapter)),
    commit: guard(adapter.commit.bind(adapter)),
    push: guard(adapter.push.bind(adapter)),
    pushBranch: guard(adapter.pushBranch.bind(adapter)),
    publish: guard(adapter.publish.bind(adapter)),
    revert: guard(adapter.revert.bind(adapter)),
    rebase: guard(adapter.rebase.bind(adapter)),
    cherryPick: guard(adapter.cherryPick.bind(adapter)),
  };
}
