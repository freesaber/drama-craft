import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

it.skipIf(!process.env.DRAMACRAFT_COMPAT_DIR)(
  "reads the external 12-episode workspace without rewriting it",
  () => {
    const root = process.env.DRAMACRAFT_COMPAT_DIR!;
    const files = readdirSync(root)
      .filter((name) => /^\d+.*\.md$/i.test(name))
      .sort();
    expect(files).toHaveLength(12);
    const counts = files.map(
      (name) =>
        analyzeMarkdown(readFileSync(join(root, name), "utf8")).shots.length,
    );
    expect(counts[0]).toBe(13);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(184);
  },
);
import {
  analyzeMarkdown,
  documentTemplate,
  isOverviewDocument,
  normalizeReference,
  sortDocuments,
} from "./markdown";
describe("existing Markdown compatibility", () => {
  it("finds real headings without treating fenced prompts as shots", () => {
    const text =
      "# 第01集\r\n\r\n## S001 等风\r\n\r\n```text\r\n## S999 not a shot\r\n```\r\n\r\n## S002 出发\r\n";
    const result = analyzeMarkdown(text);
    expect(result.shots.map((s) => s.id)).toEqual(["S001", "S002"]);
    expect(text.slice(result.shots[1].offset)).toMatch(/^## S002/);
  });
  it("extracts code filenames, angle-wrapped Windows paths, table and reference links", () => {
    const text =
      "| 图 | 路径 |\n|---|---|\n| 首帧 | `01 首帧_S001.png` |\n\n[声音](<Z:/示例素材/声音 样本.MP3>)\n![角色](assets/角色%20一.png)\n[旁白][voice]\n\n[voice]: assets/旁白.wav\n\n`ref_image_0`\n";
    expect(analyzeMarkdown(text).references).toEqual([
      "01 首帧_S001.png",
      "Z:/示例素材/声音 样本.MP3",
      "assets/角色 一.png",
      "assets/旁白.wav",
    ]);
  });
  it("does not automatically request remote assets or executable files", () => {
    for (const ref of [
      "https://example.com/image.png",
      "//server/a.png",
      "\\\\server\\a.png",
      "app.exe",
      "data:image/png",
    ])
      expect(normalizeReference(ref)).toBeNull();
  });
  it("warns about duplicate IDs while retaining both source locations", () => {
    const result = analyzeMarkdown("## S001 一\n\n## S001 二");
    expect(result.shots).toHaveLength(2);
    expect(result.diagnostics).toHaveLength(1);
  });
  it("sorts numbered episodes naturally after the outline and overview", () => {
    const names = [
      "10 十.md",
      "2 二.md",
      "AGENTS.md",
      "剧本大纲.md",
      "分镜总表.md",
    ];
    expect(
      sortDocuments(names.map((name) => ({ name, path: name }))).map(
        (d) => d.name,
      ),
    ).toEqual([
      "剧本大纲.md",
      "分镜总表.md",
      "2 二.md",
      "10 十.md",
      "AGENTS.md",
    ]);
  });
  it("recognizes overview documents by basename", () => {
    expect(isOverviewDocument("剧本大纲.md")).toBe(true);
    expect(isOverviewDocument("资料/分镜总表.md")).toBe(true);
    expect(isOverviewDocument("01 分镜总表.md")).toBe(false);
    expect(isOverviewDocument("01 共仓无根.md")).toBe(false);
  });
  it("creates a standalone episode with separate first-frame and video sections", () => {
    const template = documentTemplate("episode", "03 渡口.md");
    expect(template).toContain("### 首帧生成");
    expect(template).toContain("### 视频生成");
    expect(template).toContain(
      "在此逐字写入用户已确认的完整核心画面风格词",
    );
    expect(analyzeMarkdown(template).shots).toHaveLength(1);
    expect(analyzeMarkdown(template).references).toContain("03 S001.mp4");
  });
});
