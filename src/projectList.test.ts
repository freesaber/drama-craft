import { describe, expect, it } from "vitest";
import {
  filterAndSortProjects,
  projectPage,
  projectPageCount,
} from "./projectList";
import type { Recent } from "./types";

const project = (name: string, createdAt?: string): Recent => ({
  name,
  path: `F:\\项目\\${name}`,
  createdAt,
});

describe("project list", () => {
  it("sorts projects by creation time descending and preserves legacy order", () => {
    const items = [
      project("旧项目甲"),
      project("旧项目乙"),
      project("较新", "2026-09-15T08:00:00Z"),
      project("最新", "2026-09-15T09:00:00Z"),
    ];
    expect(filterAndSortProjects(items, "").map((item) => item.name)).toEqual([
      "最新",
      "较新",
      "旧项目甲",
      "旧项目乙",
    ]);
  });

  it("searches names and paths without case sensitivity", () => {
    const items = [project("Drama-A"), project("中文项目")];
    expect(filterAndSortProjects(items, "drama")).toHaveLength(1);
    expect(filterAndSortProjects(items, "项目\\中文")).toHaveLength(1);
  });

  it("paginates projects in groups of ten", () => {
    const items = Array.from({ length: 21 }, (_, index) =>
      project(`项目${index + 1}`),
    );
    expect(projectPageCount(items.length)).toBe(3);
    expect(projectPage(items, 2)).toHaveLength(10);
    expect(projectPage(items, 3)).toHaveLength(1);
  });
});
