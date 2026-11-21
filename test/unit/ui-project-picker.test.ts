import { describe, expect, it } from "vitest";
import {
  mergeProjects,
  projectSubtitle,
  projectTitle,
  toProjectSelectOption,
  type ProjectOption,
} from "../../src/app/ui/projectPicker.ts";

function project(overrides: Partial<ProjectOption> & { id: number }): ProjectOption {
  return { http_url_to_repo: "", ...overrides } as ProjectOption;
}

describe("operations UI project picker", () => {
  it("prefers the namespace path as the title", () => {
    expect(projectTitle(project({ id: 1, name: "Corvex", path_with_namespace: "axetroy/Corvex" }))).toBe("axetroy/Corvex");
  });

  it("falls back to the project name and then the id", () => {
    expect(projectTitle(project({ id: 1, name: "Corvex" }))).toBe("Corvex");
    expect(projectTitle(project({ id: 7 }))).toBe("#7");
  });

  it("uses the description as the subtitle when present", () => {
    expect(projectSubtitle(project({ id: 1, description: "GitLab review bot" }))).toBe("GitLab review bot");
  });

  it("collapses multi-line descriptions into a single line", () => {
    expect(projectSubtitle(project({ id: 1, description: "  line one\n\n line   two  " }))).toBe("line one line two");
  });

  it("falls back to the name when there is no description and it differs from the path", () => {
    expect(projectSubtitle(project({ id: 1, name: "Corvex", path_with_namespace: "axetroy/Corvex" }))).toBe("Corvex");
  });

  it("keeps a two-line structure by falling back to the id", () => {
    expect(projectSubtitle(project({ id: 9, name: "Corvex", path_with_namespace: "Corvex" }))).toBe("#9");
  });

  it("assembles a select option with both lines", () => {
    expect(toProjectSelectOption(project({ id: 3, path_with_namespace: "group/app", description: "Web app" }))).toEqual({
      value: 3,
      title: "group/app",
      subtitle: "Web app",
      project: project({ id: 3, path_with_namespace: "group/app", description: "Web app" }),
    });
  });

  it("appends a page without duplicating projects that already exist", () => {
    const first = [project({ id: 1 }), project({ id: 2 })];
    const second = [project({ id: 2 }), project({ id: 3 })];
    expect(mergeProjects(first, second).map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it("keeps the first occurrence when a project appears twice", () => {
    const first = [project({ id: 1, name: "original" })];
    const second = [project({ id: 1, name: "duplicate" })];
    expect(mergeProjects(first, second)[0].name).toBe("original");
  });

  it("returns an empty list when both pages are empty", () => {
    expect(mergeProjects([], [])).toEqual([]);
  });
});
