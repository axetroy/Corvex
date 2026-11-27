import { describe, expect, it } from "vitest";
import {
  authorFromUser,
  userCommitMessage,
  withCommitTrailer,
} from "../../src/git/commit-identity.ts";
import { needsCommitMessageRewrite } from "../../src/git/commit-message.ts";

describe("commit attribution", () => {
  it("appends exactly one configured trailer and keeps the user message intact", () => {
    const trailer = "Assisted-by: Acme Agent";
    const message = withCommitTrailer("feat(ui): add thing", trailer);
    expect(message).toBe(`feat(ui): add thing\n\n${trailer}`);
    expect(withCommitTrailer(message, trailer)).toBe(message);
    expect(withCommitTrailer("feat(ui): add thing", "")).toBe("feat(ui): add thing");
    expect(userCommitMessage(message)).toBe("feat(ui): add thing");
  });

  it("does not treat an already-attributed message as needing a rewrite", () => {
    const committed = withCommitTrailer("Corvex conversation changes abc", "Assisted-by: Agent");
    expect(needsCommitMessageRewrite(committed, "Corvex conversation changes abc")).toBe(false);
    expect(needsCommitMessageRewrite(committed, "do the thing")).toBe(true);
  });

  it("uses the configured fallback author, never an agent author", () => {
    const fallback = { name: "Acme", email: "acme@localhost" };
    expect(authorFromUser({ name: "Alice", username: "alice" }, "gitlab.example.com", fallback))
      .toEqual({ name: "Alice", email: "alice@users.noreply.gitlab.example.com" });
    expect(authorFromUser(undefined, "", fallback)).toEqual(fallback);
  });
});
