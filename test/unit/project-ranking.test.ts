import { describe, expect, it } from "vitest";
import { rankProjects, type ProjectActivity } from "../../src/app/http/ops/project-ranking.js";
import type { Project } from "../../src/gitlab/client.js";

const now = Date.parse("2026-11-26T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

function project(id: number, name: string, path: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name,
    path_with_namespace: path,
    http_url_to_repo: `https://gitlab.example.com/${path}.git`,
    last_activity_at: daysAgo(1),
    ...extra,
  };
}

describe("project search ranking", () => {
  it("ranks exact and word-boundary matches above plain substrings", () => {
    const projects = [
      project(1, "timer", "team/timer"),
      project(2, "im", "dhweicheng/im"),
      project(3, "im_pc", "digimaple/cloudoc_im_pc"),
    ];
    const ranked = rankProjects(projects, "im", new Map(), now);
    expect(ranked.map((item) => item.id)).toEqual([2, 3, 1]);
    expect(ranked[0].score).toBeGreaterThan(ranked[2].score);
  });

  it("uses conversation activity to break similar matches", () => {
    const activity = new Map<number, ProjectActivity>([
      [2, { lastConversationAt: daysAgo(2), conversationCount: 12 }],
    ]);
    const ranked = rankProjects([
      project(1, "cloudoc_im_h5", "digimaple/cloudoc_im_h5", { last_activity_at: daysAgo(90) }),
      project(2, "cloudoc_im_pc", "digimaple/cloudoc_im_pc", { last_activity_at: daysAgo(90) }),
    ], "im", activity, now);
    expect(ranked[0].id).toBe(2);
  });

  it("moves archived projects to the end despite high similarity", () => {
    const ranked = rankProjects([
      project(1, "im", "dhweicheng/im", { archived: true }),
      project(2, "cloudoc_im_pc", "digimaple/cloudoc_im_pc"),
    ], "im", new Map(), now);
    expect(ranked[0].id).toBe(2);
    expect(ranked[1].archived).toBe(true);
  });

  it("keeps a stable path order for equal scores", () => {
    const ranked = rankProjects([
      project(1, "im", "z/im"),
      project(2, "im", "a/im"),
    ], "im", new Map(), now);
    expect(ranked.map((item) => item.id)).toEqual([2, 1]);
  });
});
