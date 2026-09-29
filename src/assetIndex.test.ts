import { describe, expect, it } from "vitest";
import {
  checkAssetSource,
  indexedGenerationPrompt,
  parseAssetIndex,
  searchAssets,
} from "./assetIndex";
import { createEpisodeTemplate } from "./episodeFormat";
import { parseStoryboard } from "./storyboard";

const document = "01 集名.md";
const entries = [
  {
    id: "C0001",
    type: "character",
    name: "秦墨",
    aliases: ["阿墨"],
    keywords: ["青年"],
    firstDocument: document,
  },
  {
    id: "A0001",
    type: "scene",
    name: "王宫大殿",
    aliases: ["大殿"],
    keywords: ["王宫"],
    firstDocument: document,
  },
];

describe("asset index", () => {
  it("searches compact records without copying prompts or file names", () => {
    const result = parseAssetIndex(
      JSON.stringify({ schemaVersion: 1, assets: entries }),
      [document],
    );
    expect(result.diagnostics).toEqual([]);
    expect(searchAssets(result.assets, "阿墨").map((item) => item.id)).toEqual([
      "C0001",
    ]);
    expect(
      searchAssets(result.assets, "王宫", "scene").map((item) => item.id),
    ).toEqual(["A0001"]);
    expect(JSON.stringify(result.assets)).not.toContain(".png");
  });

  it("reports duplicate IDs, unsafe or missing sources, and invalid types", () => {
    const result = parseAssetIndex(
      JSON.stringify({
        schemaVersion: 1,
        assets: [
          entries[0],
          entries[0],
          { ...entries[1], firstDocument: "../outside.md" },
          { ...entries[1], id: "A0002", firstDocument: "missing.md" },
          { ...entries[1], id: "A0003", type: "character" },
        ],
      }),
      [document],
    );
    expect(result.diagnostics.join(" ")).toMatch(/重复|相对|不存在|不匹配/);
  });

  it("resolves matching four-digit source rows and keeps old three-digit episodes readable", () => {
    const source = createEpisodeTemplate("01 集名", "01")
      .replace(
        "|---|---|---|---|---|\n\n## 本集使用素材",
        "|---|---|---|---|---|\n| C0001 | 秦墨 | `01 素材_秦墨.png` | — | S0001 |\n\n## 本集使用素材",
      )
      .replace(
        "|---|---|---|---|---|\n\n## 本集声音安排",
        "|---|---|---|---|---|\n| A0001 | 王宫大殿 | 场景 | `01 素材_王宫大殿.png` | S0001 |\n\n## 本集声音安排",
      )
      .replace("角色：—", "角色：C0001");
    expect(parseStoryboard(source).cards[0].id).toBe("S0001");
    const parsed = parseAssetIndex(
      JSON.stringify({ schemaVersion: 1, assets: entries }),
      [document],
    );
    expect(checkAssetSource(parsed.assets[0], source)).toEqual([]);
    expect(checkAssetSource(parsed.assets[1], source)).toEqual([]);
    const old = `<!-- drama-craft:episode:v1 -->\n\n# 第01集 旧剧本\n\n## 角色绑定\n\n| 角色ID | 名称 | 角色图 | 音色文件 | 使用镜号 |\n|---|---|---|---|---|\n| C001 | 旅人 | — | — | S001 |\n\n## S001 旧镜头\n\n角色：C001\n\n### 故事走向\n\n旅人前行。\n`;
    expect(parseStoryboard(old).cards[0].id).toBe("S001");
    expect(parseStoryboard(old).episode.characters[0].id).toBe("C001");
  });

  it("reads a reused scene prompt from its indexed first document and rejects a changed file", () => {
    const source = createEpisodeTemplate("01 集名", "01").replace(
      "|---|---|---|---|---|\n\n## 本集声音安排",
      "|---|---|---|---|---|\n| A0001 | 王宫大殿 | 场景 | `01 素材_王宫大殿.png` | S0001 |\n\n### 王宫大殿\n\n```text\n王宫大殿完整提示词\n```\n\n## 本集声音安排",
    );
    const index = parseAssetIndex(
      JSON.stringify({ schemaVersion: 1, assets: entries }),
      [document],
    );
    expect(
      indexedGenerationPrompt(
        index.assets,
        "A0001",
        "王宫大殿",
        "01 素材_王宫大殿.png",
        source,
      ),
    ).toEqual({ prompt: "王宫大殿完整提示词", firstDocument: document });
    expect(
      indexedGenerationPrompt(
        index.assets,
        "A0001",
        "王宫大殿",
        "04 素材_王宫大殿.png",
        source,
      ),
    ).toBeNull();
    expect(
      indexedGenerationPrompt(
        index.assets,
        "A0001",
        "别的场景",
        "01 素材_王宫大殿.png",
        source,
      ),
    ).toBeNull();
  });
});
