import type { Recent } from "./types";

export const PROJECTS_PER_PAGE = 10;

export function filterAndSortProjects(items: Recent[], query: string) {
  const keyword = query.trim().toLocaleLowerCase();
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (!keyword) return true;
      return `${item.name}\n${item.path}`.toLocaleLowerCase().includes(keyword);
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.item.updatedAt ?? "");
      const rightTime = Date.parse(right.item.updatedAt ?? "");
      const leftValue = Number.isNaN(leftTime) ? Number.NEGATIVE_INFINITY : leftTime;
      const rightValue = Number.isNaN(rightTime)
        ? Number.NEGATIVE_INFINITY
        : rightTime;
      return rightValue - leftValue || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function projectPageCount(total: number) {
  return Math.max(1, Math.ceil(total / PROJECTS_PER_PAGE));
}

export function projectPage(items: Recent[], page: number) {
  const start = (page - 1) * PROJECTS_PER_PAGE;
  return items.slice(start, start + PROJECTS_PER_PAGE);
}
