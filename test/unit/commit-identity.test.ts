import { describe, expect, it } from "vitest";
import {
  agentCommitTrailer,
  authorFromUser,
  userCommitMessage,
  withAgentTrailer,
} from "../../src/git/commit-identity.ts";
import { needsCommitMessageRewrite } from "../../src/git/commit-message.ts";

describe("commit attribution", () => {
  it("appends exactly one trailer and keeps the user message intact", () => {
    const message = withAgentTrailer("feat(ui): add thing");
    expect(message).toBe(`feat(ui): add thing\n\n${agentCommitTrailer}`);
    expect(withAgentTrailer(message)).toBe(message);
    expect(userCommitMessage(message)).toBe("feat(ui): add thing");
  });

  it("does not treat an already-attributed message as needing a rewrite", () => {
    const committed = withAgentTrailer("Corvex conversation changes abc");
    expect(needsCommitMessageRewrite(committed, "Corvex conversation changes abc")).toBe(false);
    expect(needsCommitMessageRewrite(committed, "do the thing")).toBe(true);
  });

  it("uses the GitLab user identity, never an agent author", () => {
    expect(authorFromUser({ name: "Alice", username: "alice" }, "gitlab.example.com"))
      .toEqual({ name: "Alice", email: "alice@users.noreply.gitlab.example.com" });
    expect(authorFromUser(undefined, "")).toEqual({ name: "Corvex", email: "corvex@localhost" });
  });
});
