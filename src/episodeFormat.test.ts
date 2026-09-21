import { describe, expect, it } from "vitest";
import { createEpisodeTemplate } from "./episodeFormat";

describe("createEpisodeTemplate", () => {
  it("leaves the video style dynamic and preserves it from the first frame", () => {
    const template = createEpisodeTemplate("01 示例", "01");

    expect(template).toContain("detailed_description:");
    expect(template).toContain(
      "The target video uses [replace with the visual style confirmed with the user, written in concise English].",
    );
    expect(template).toContain(
      "Maintain that style and the rendering of <Picture 1> throughout the video.",
    );
    expect(template).not.toContain("禁止转成 3D、写实或其他未确认风格");
    expect(template).not.toContain("参考图只约束外貌与场景");
  });
});
