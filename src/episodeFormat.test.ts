import { describe, expect, it } from "vitest";
import { createEpisodeTemplate } from "./episodeFormat";

describe("createEpisodeTemplate", () => {
  it("reminds authors to preserve the confirmed visual style in video prompts", () => {
    const template = createEpisodeTemplate("01 示例", "01");

    expect(template).toContain("画面风格：[此处写入已确认的画面风格]。");
    expect(template).not.toContain("禁止转成 3D、写实或其他未确认风格");
    expect(template).not.toContain("参考图只约束外貌与场景");
  });
});
