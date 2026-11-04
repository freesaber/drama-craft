import { describe, expect, it } from "vitest";
import { createEpisodeTemplate } from "./episodeFormat";

describe("createEpisodeTemplate", () => {
  it("leaves the video style dynamic and preserves it from the first frame", () => {
    const template = createEpisodeTemplate("01 示例", "01");

    expect(template).toContain("# 第0001集 示例");
    expect(template).toContain("0001 首帧_S0001.png");
    expect(template).toContain("0001 S0001.mp4");
    expect(template).toContain("detailed_description:");
    expect(template).toContain(
      "画面风格为[填入已确认的核心画面风格词]。",
    );
    expect(template).toContain(
      "全程沿用 <Picture 1> 的画风与渲染。",
    );
    expect(template).not.toContain("禁止转成 3D、写实或其他未确认风格");
    expect(template).not.toContain("参考图只约束外貌与场景");
  });
});
