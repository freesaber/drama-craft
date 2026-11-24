import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FirstFrameGalleryDialog from "./FirstFrameGalleryDialog";
import {
  clampGalleryIndex,
  coverflowSlotStyle,
  firstFrameReference,
  stepGalleryIndex,
} from "./firstFrameGallery";
import { parseStoryboard } from "./storyboard";
import type { Project } from "./types";

const project: Project = {
  handle: "test-project",
  root: "",
  metadata: {
    id: "test-project",
    name: "示例项目",
    formatVersion: 1,
    layout: "preserve",
    libraries: { voices: "" },
  },
  warning: null,
};

const sampleEpisode = [
  "<!-- drama-craft:episode:v1 -->",
  "",
  "# 第0001集 渡口灯火",
  "",
  "本集内容：测试首帧相册弹框。",
  "",
  "## 角色绑定",
  "",
  "| 角色ID | 名称 | 角色图 | 音色文件 |",
  "|---|---|---|---|",
  "| C0001 | 秦墨 | `0001 素材_秦墨.png` | `F:/voices/a.mp3` |",
  "",
  "## 本集使用素材",
  "",
  "| 素材ID | 名称 | 类型 | 文件 |",
  "|---|---|---|---|",
  "",
  "## 本集声音安排",
  "",
  "| 镜号 | 角色ID | 角色名称 | 台词 |",
  "|---|---|---|---|",
  "",
  "## S0001 王宫大殿",
  "",
  "角色：C0001",
  "",
  "### 故事走向",
  "",
  "秦墨步入王宫大殿。",
  "",
  "### 首帧生成",
  "",
  "出图文件名：`0001 首帧_S0001.png`。",
  "",
  "## S0002 长廊回望",
  "",
  "角色：C0001",
  "",
  "### 故事走向",
  "",
  "秦墨在长廊停下脚步回望。",
  "",
  "### 视频生成",
  "",
  "| API参数 | 提示词标签 | 上传素材 |",
  "|---|---|---|",
  "| `ref_image_0` | `<Picture 1>` | `0001 首帧_S0002.png` |",
  "",
  "## S0003 空镜待补",
  "",
  "角色：C0001",
  "",
  "### 故事走向",
  "",
  "远处灯火微明。",
  "",
].join("\n");

describe("firstFrameGallery helpers", () => {
  it("resolves explicit frameFile first and falls back to Picture 1", () => {
    const board = parseStoryboard(sampleEpisode);
    expect(firstFrameReference(board.cards[0])).toBe("0001 首帧_S0001.png");
    expect(firstFrameReference(board.cards[1])).toBe("0001 首帧_S0002.png");
    expect(firstFrameReference(board.cards[2])).toBe("");
  });

  it("clamps and steps gallery indices within bounds", () => {
    expect(clampGalleryIndex(-3, 5)).toBe(0);
    expect(clampGalleryIndex(2.8, 5)).toBe(2);
    expect(clampGalleryIndex(99, 5)).toBe(4);
    expect(clampGalleryIndex(2, 0)).toBe(0);

    expect(stepGalleryIndex(0, -1, 4)).toBe(0);
    expect(stepGalleryIndex(1, 1, 4)).toBe(2);
    expect(stepGalleryIndex(3, 1, 4)).toBe(3);
  });

  it("computes symmetric coverflow slots with decreasing scale and depth", () => {
    const center = coverflowSlotStyle(0);
    const left1 = coverflowSlotStyle(-1);
    const right1 = coverflowSlotStyle(1);
    const left2 = coverflowSlotStyle(-2);
    const right3 = coverflowSlotStyle(3);
    const hidden = coverflowSlotStyle(5);

    expect(center.visible).toBe(true);
    expect(center.scale).toBe(1);
    expect(center.translateXPercent).toBe(0);
    expect(center.zIndex).toBeGreaterThan(right1.zIndex);

    expect(left1.translateXPercent).toBe(-right1.translateXPercent);
    expect(left1.scale).toBe(right1.scale);
    expect(left1.zIndex).toBe(right1.zIndex);
    expect(left1.scale).toBeGreaterThan(left2.scale);
    expect(left2.scale).toBeGreaterThan(right3.scale);
    expect(right3.visible).toBe(true);
    expect(hidden.visible).toBe(false);
  });
});

describe("FirstFrameGalleryDialog", () => {
  it("renders current shot header, stacked cards, discarded tag, and shot strip", () => {
    const board = parseStoryboard(sampleEpisode);
    const html = renderToStaticMarkup(
      <FirstFrameGalleryDialog
        project={project}
        document="0001 渡口灯火.md"
        board={board}
        refreshKey={0}
        initialIndex={1}
        discardedShotIds={["S0002"]}
        onLocate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("S0002");
    expect(html).toContain("长廊回望");
    expect(html).toContain("定位到此镜头");
    expect(html).toContain("已丢弃");
    expect(html).toContain("2 / 3");
    expect(html).toContain('data-offset="-1"');
    expect(html).toContain('data-offset="0"');
    expect(html).toContain('data-offset="1"');
    expect(html).toContain("0001 首帧_S0002.png");
    expect(html).toContain("秦墨在长廊停下脚步回望。");
  });

  it("renders empty state when there are no shots", () => {
    const board = parseStoryboard("# 说明\n\n暂无镜头。\n");
    const html = renderToStaticMarkup(
      <FirstFrameGalleryDialog
        project={project}
        document="说明.md"
        board={board}
        refreshKey={0}
        onLocate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("本集没有分镜。");
  });
});
