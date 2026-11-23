import { describe, expect, it } from "vitest";
import { documentTemplate } from "./markdown";
import { applySourcePatch, fieldPatch, parseStoryboard } from "./storyboard";
import type { BoardField } from "./types";

function edit(source: string, key: BoardField, value: string) {
  const board = parseStoryboard(source);
  return applySourcePatch(
    source,
    fieldPatch(board, board.cards[0].fields[key], value),
  );
}
const template = documentTemplate("episode", "01 灯火.md");

describe("storyboard structure", () => {
  it("reads output filenames before inline saving and attachment instructions", () => {
    const source =
      "## S0001 点灯\n\n### 首帧生成\n\n出图文件名：`01 首帧_S0001.png`。保存位置：与本集文档同目录。GPT附件：**图片1＝场景（`场景.png`）**。\n\n### 视频生成\n\n视频文件名：`01 S0001.mp4`。保存位置：与本集文档同目录。\n";
    const card = parseStoryboard(source).cards[0];
    expect(card.fields.frameFile.value).toBe("01 首帧_S0001.png");
    expect(card.fields.videoFile.value).toBe("01 S0001.mp4");
    expect(card.frameAssets).toEqual([
      { label: "图片1", name: "场景", reference: "场景.png" },
    ]);
    expect(edit(source, "videoFile", "新视频.mp4")).toBe(
      source.replace("01 S0001.mp4", "新视频.mp4"),
    );
  });
  it("reads video upload slots from the API mapping table", () => {
    const source = `${documentTemplate("episode", "01 灯火.md").replace(
      "| `ref_image_0` | `<Picture 1>` | `0001 首帧_S0001.png` |",
      "| `ref_image_0` | `<Picture 1>` | `0001 首帧_S0001.png` |\n| `ref_image_1` | `<Picture 2>` | `01 素材_苏铭.png` |\n| `ref_audio_0` | `<Audio 1>` | `F:/voices/旁白.MP3` |",
    )}`;
    expect(parseStoryboard(source).cards[0].videoInputs).toEqual([
      {
        param: "ref_image_0",
        tag: "<Picture 1>",
        reference: "0001 首帧_S0001.png",
        kind: "image",
      },
      {
        param: "ref_image_1",
        tag: "<Picture 2>",
        reference: "01 素材_苏铭.png",
        kind: "image",
      },
      {
        param: "ref_audio_0",
        tag: "<Audio 1>",
        reference: "F:/voices/旁白.MP3",
        kind: "audio",
      },
    ]);
  });
  it("keeps image-only mapping tables without inventing audio slots", () => {
    const source = documentTemplate("episode", "01 灯火.md")
      .replace(
        "|---|---|---|---|",
        "|---|---|---|---|\n| C0001 | 苏铭 | `01 素材_苏铭.png` | `F:/voices/苏铭.mp3` |",
      )
      .replace("角色：—", "角色：C0001")
      .replace(
        "| `ref_image_0` | `<Picture 1>` | `0001 首帧_S0001.png` |",
        "| `ref_image_0` | `<Picture 1>` | `0001 首帧_S0001.png` |\n| `ref_image_1` | `<Picture 2>` | `01 素材_苏铭.png` |",
      );
    const card = parseStoryboard(source).cards[0];
    expect(card.videoInputs.map((item) => item.kind)).toEqual([
      "image",
      "image",
    ]);
    expect(card.videoInputs.some((item) => item.kind === "audio")).toBe(false);
  });
  it("extracts named GPT attachments only from the first-frame section", () => {
    const source =
      "## S0007 私粮\n\n### 首帧生成\n\n出图文件名：`01 首帧_S0007.png`。保存位置：同目录。GPT附件：**图片1＝白石村寨空粮仓（`01 素材_空粮仓.png`）；图片2＝大猩猩拳师参考图（[0071 大猩猩拳师.png](<F:/角色/0071 大猩猩拳师.png>)）**。\n\n**首帧图片提示词**\n\n```text\n静态画面\n```\n\n### 视频生成\n\n`不应出现.png`\n";
    expect(parseStoryboard(source).cards[0].frameAssets).toEqual([
      {
        label: "图片1",
        name: "白石村寨空粮仓",
        reference: "01 素材_空粮仓.png",
      },
      {
        label: "图片2",
        name: "大猩猩拳师参考图",
        reference: "F:/角色/0071 大猩猩拳师.png",
      },
    ]);
  });
  it("extracts temporary frame assets from the first-frame section without mixing with GPT attachments", () => {
    const source =
      "## S0001 点灯\n\n### 首帧生成\n\n出图文件名：`0001 首帧_S0001.png`。\n\nGPT附件：**图片1＝渡口场景（`0001 素材_渡口.png`）；图片2＝渡口空间机位图（`0001 素材_渡口空间机位图.png`）**。\n\n临时素材：**临时1＝新机位空景（`0001 临时_S0001_01.png`）；临时2＝人物站位草稿（`0001 临时_S0001_02.png`）**。\n\n**首帧图片提示词**\n\n```text\n【分步生图】\n步骤1：生成空景\n```\n\n### 视频生成\n\n临时素材：`不应识别.png`\n";
    const card = parseStoryboard(source).cards[0];
    expect(card.frameAssets).toEqual([
      {
        label: "图片1",
        name: "渡口场景",
        reference: "0001 素材_渡口.png",
      },
      {
        label: "图片2",
        name: "渡口空间机位图",
        reference: "0001 素材_渡口空间机位图.png",
      },
    ]);
    expect(card.tempAssets).toEqual([
      {
        label: "临时1",
        name: "新机位空景",
        reference: "0001 临时_S0001_01.png",
      },
      {
        label: "临时2",
        name: "人物站位草稿",
        reference: "0001 临时_S0001_02.png",
      },
    ]);
    expect(card.fields.framePrompt.value).toContain("步骤1：生成空景");
  });
  it("handles inline GPT attachments and temporary assets in the same paragraph", () => {
    const source =
      "## S0002 合行\n\n### 首帧生成\n\n出图文件名：`0001 首帧_S0002.png`。GPT附件：**图片1＝场景（`场景.png`）**。临时素材：**步骤1＝空景底图（`0001 临时_S0002_01.png`）**。\n";
    const card = parseStoryboard(source).cards[0];
    expect(card.frameAssets).toEqual([
      { label: "图片1", name: "场景", reference: "场景.png" },
    ]);
    expect(card.tempAssets).toEqual([
      {
        label: "步骤1",
        name: "空景底图",
        reference: "0001 临时_S0002_01.png",
      },
    ]);
  });
  it("recognizes only top-level standalone markers including titleless headings", () => {
    const source =
      "# 本集\n\nS1 起点\n\n正文\n\n## s002\n\n```md\n## S0999 假标题\n```\n\n> S0003 引用\n\n| S0004 表格 |\n|---|\n\n这里提到 S0005\n\nS006 连续正文\n不应该拆分\n\n### S0007 终点\n";
    const board = parseStoryboard(source);
    expect(board.cards.map((c) => c.id)).toEqual(["S1", "S002", "S0007"]);
    expect(board.cards[1].title).toBe("");
  });
  it("retains all bytes and independent sections in source order", () => {
    const source =
      "# 本集资料\r\n\r\n## S0001 一\r\n正文\r\n\r\n## 场景资料\r\n原样保留\r\n\r\nS002 二\r\n\r\n正文\r\n\r\n# 附录\r\n";
    const board = parseStoryboard(source);
    expect(
      board.sections
        .map((s) =>
          s.kind === "document"
            ? source.slice(s.range.start, s.range.end)
            : source.slice(
                board.cards[s.index].offset,
                board.cards[s.index].end,
              ),
        )
        .join(""),
    ).toBe(source);
  });
  it("retains duplicate cards separately", () => {
    const board = parseStoryboard("## S0001 一\n\n## s0001 二\n");
    expect(board.cards).toHaveLength(2);
    expect(board.diagnostics).toHaveLength(1);
    const next = applySourcePatch(
      board.source,
      fieldPatch(board, board.cards[1].fields.title, "只修改第二张"),
    );
    expect(next).toBe("## S0001 一\n\n## s0001 只修改第二张\n");
  });
  it("binds template fields without guessing arbitrary code blocks", () => {
    const fields = parseStoryboard(template).cards[0].fields;
    expect(fields.framePrompt.value).toContain("群像素材图");
    expect(fields.videoPrompt.value).toContain("摄影机");
    expect(fields.duration.value).toBe("5");
    expect(fields.resolution.value).toBe("480p横(864*480)");
    expect(fields.frameFile.value).toBe("0001 首帧_S0001.png");
    expect(fields.videoFile.value).toBe("0001 S0001.mp4");
    expect(fields.story.range).toBeDefined();
    expect(
      parseStoryboard("## S0001 一\n\n### 首帧生成\n\n```\n自定义\n```\n")
        .cards[0].fields.framePrompt.ambiguous,
    ).toBe(true);
  });
  it("declines duplicate, malformed and unclosed prompt fields", () => {
    for (const extra of [
      "\n**视频提示词**\n\n```text\n重复\n```\n",
      "\n**视频提示词**\n无代码块\n",
      "\n### 视频生成\n",
    ]) {
      expect(
        parseStoryboard(template + extra).cards[0].fields.videoPrompt.ambiguous,
      ).toBe(true);
    }
    expect(
      parseStoryboard("## S0001 一\n\n**视频提示词**\n\n```text\n未闭合")
        .cards[0].fields.videoPrompt.ambiguous,
    ).toBe(true);
  });
  it("uses whole-document definitions and preserves Chinese/space paths", () => {
    const source =
      "[图]: <素材/角色 一.png>\n\n## S0001 一\n\n![角色][图]\n\n`声音 一.wav`\n\n## S0002 二\n\n[图][图]\n";
    const board = parseStoryboard(source);
    expect(board.cards[0].references.map((r) => r.reference)).toEqual([
      "素材/角色 一.png",
      "声音 一.wav",
    ]);
    const field = board.cards[1].references[0].field;
    const next = applySourcePatch(
      source,
      fieldPatch(board, field, "素材/角色 二.png"),
    );
    expect(next).toBe(source.replace("角色 一.png", "角色 二.png"));
    expect(parseStoryboard(next).cards[0].references[0].reference).toBe(
      "素材/角色 二.png",
    );
  });
});

describe("source patches", () => {
  it("changes only a target range and rejects stale offsets", () => {
    const board = parseStoryboard(template);
    const patch = fieldPatch(board, board.cards[0].fields.title, "点灯");
    expect(applySourcePatch(template, patch)).toBe(
      template.replace("## S0001 镜头名", "## S0001 点灯"),
    );
    expect(() => applySourcePatch("\n" + template, patch)).toThrow();
  });
  it("adds story only after an edit, preserves CRLF and arbitrary content", () => {
    const source =
      template.replace("### 故事走向\n\n", "").replaceAll("\n", "\r\n") +
      "\r\n<!-- 自定义 -->\r\n\r\n| 私有字段 | 值 |\r\n|---|---|\r\n";
    const next = edit(source, "story", "旅人点亮灯。\n船夫看见亮光。");
    expect(next.startsWith(source)).toBe(true);
    expect(next).not.toMatch(/(?<!\r)\n/);
    expect(parseStoryboard(next).cards[0].fields.story.value).toBe(
      "旅人点亮灯。\r\n船夫看见亮光。",
    );
    expect(edit(next, "story", "")).toContain("<!-- 自定义 -->");
  });
  it("replaces the full story body without accumulating typed paragraph separators", () => {
    let next = edit(template, "story", "第一拍。");
    next = edit(next, "story", "第一拍。\n\n");
    next = edit(next, "story", "第一拍。\n\n第二拍。");
    expect(parseStoryboard(next).cards[0].fields.story.value).toBe(
      "第一拍。\n\n第二拍。",
    );
  });
  it("grows fences for embedded markdown without creating false shots", () => {
    const value = "```\n## S0999 仍在提示词内\n```";
    for (const source of [template, "## S0001 一\n"]) {
      const next = edit(source, "videoPrompt", value);
      expect(parseStoryboard(next).cards).toHaveLength(1);
      expect(parseStoryboard(next).cards[0].fields.videoPrompt.value).toBe(
        value,
      );
    }
  });
  it("edits or clears parameters without duplicating labels or modifying prompts", () => {
    let next = edit(template, "duration", "");
    next = edit(next, "duration", "12");
    next = edit(next, "resolution", "480p竖(480*864)");
    expect(next).toBe(
      template
        .replace("duration=5", "duration=12")
        .replace("resolution=480p横(864*480)", "resolution=480p竖(480*864)"),
    );
  });
  it("clears and re-enters a filename without losing its editable location", () => {
    const empty = edit(template, "frameFile", "");
    expect(parseStoryboard(empty).cards[0].fields.frameFile.ambiguous).not.toBe(
      true,
    );
    expect(edit(empty, "frameFile", "新 图.png")).toBe(
      template.replace(
        "出图文件名：`0001 首帧_S0001.png`",
        "出图文件名：`新 图.png`",
      ),
    );
  });
  it("inserts missing fields without changing existing content", () => {
    const source = "S0001\n\n未知段落。\n";
    const next = edit(source, "title", "第一镜");
    expect(next).toBe("S0001 第一镜\n\n未知段落。\n");
    expect(edit(next, "frameFile", "首帧.png").startsWith(next)).toBe(true);
  });
  it("does not interpret remote media or executable references", () => {
    const board = parseStoryboard(
      "## S0001 一\n\n![图](https://example.com/a.png)\n\n`run.exe`\n",
    );
    expect(board.cards[0].references).toEqual([]);
  });
  it("preserves complex link destinations and prose resembling a parameter label", () => {
    const board = parseStoryboard(
      "## S0001 一\n\n[图](frame(1).png)\n\n视频提示词说明：请自由编辑。\n",
    );
    expect(board.cards[0].references[0].reference).toBe("frame(1).png");
    expect(board.cards[0].references[0].field.ambiguous).toBe(true);
    expect(board.cards[0].fields.duration.ambiguous).toBe(true);
    expect(() =>
      fieldPatch(board, board.cards[0].references[0].field, "new.png"),
    ).toThrow();
  });
});
