import { describe, expect, it } from "vitest";
import {
  hasSelectedVideo,
  shotGenerationPayload,
  shotImageInputs,
} from "./generationInputs";
import type { EpisodeData, ShotCard, SourceField } from "./types";

const field = (value: string): SourceField => ({ value });

function card(partial: {
  id: string;
  title?: string;
  videoPrompt?: string;
  duration?: string;
  resolution?: string;
  frameFile?: string;
  videoFile?: string;
  videoInputs?: ShotCard["videoInputs"];
}): ShotCard {
  return {
    id: partial.id,
    title: partial.title ?? "",
    offset: 0,
    line: 1,
    end: 10,
    headingEnd: 1,
    depth: 2,
    fields: {
      title: field(""),
      story: field(""),
      framePrompt: field(""),
      videoPrompt: field(partial.videoPrompt ?? ""),
      duration: field(partial.duration ?? "5"),
      resolution: field(partial.resolution ?? "768p竖(768*1376)"),
      frameFile: field(partial.frameFile ?? ""),
      videoFile: field(partial.videoFile ?? ""),
    },
    frameAssets: [],
    videoInputs: partial.videoInputs ?? [],
    references: [],
    diagnostics: [],
  };
}

const episode: EpisodeData = {
  format: "v1",
  title: "测试",
  summary: "",
  characters: [],
  assets: [],
  dialogues: [],
  castByShot: {},
  diagnostics: [],
};

describe("generationInputs", () => {
  it("detects missing video and builds payload from frame", () => {
    const shot = card({
      id: "S001",
      videoPrompt: "镜头推进",
      frameFile: "frame.png",
    });
    expect(hasSelectedVideo(shot, false)).toBe(false);
    expect(shotImageInputs(shot, episode)).toEqual([
      { reference: "frame.png", label: "首帧" },
    ]);
    expect(shotGenerationPayload(shot, episode)?.shotId).toBe("S001");
  });

  it("does not treat a planned video filename as already generated", () => {
    const shot = card({
      id: "S009",
      videoPrompt: "宿舍夜思",
      frameFile: "01 首帧_S009.png",
      videoFile: "01 S009.mp4",
    });
    expect(hasSelectedVideo(shot, false)).toBe(false);
    expect(hasSelectedVideo(shot, true)).toBe(true);
    expect(shotGenerationPayload(shot, episode)?.shotId).toBe("S009");
  });

  it("maps short resolution labels onto the current API list", () => {
    const shot = card({
      id: "S009",
      videoPrompt: "宿舍夜思",
      frameFile: "01 首帧_S009.png",
      resolution: "480p横",
    });
    expect(
      shotGenerationPayload(shot, episode, {
        resolutions: ["480p竖(480*864)", "480p横(864*480)"],
        defaultResolution: "480p竖(480*864)",
      })?.resolution,
    ).toBe("480p横(864*480)");
  });

  it("rejects cards without prompt or images", () => {
    expect(
      shotGenerationPayload(card({ id: "S002", videoPrompt: "" }), episode),
    ).toBeNull();
  });
});
