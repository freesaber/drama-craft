import { describe, expect, it } from "vitest";
import {
  generationPromptIssues,
  hasSelectedVideo,
  prepareGenerationSelection,
  regenerationSelections,
  replayGenerationReferences,
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
  it("does not auto-add episode materials to a shot without a shot material mapping", () => {
    const episodeData: EpisodeData = {
      ...episode,
      assets: [
        {
          id: "A0001",
          name: "渡口",
          kind: "场景",
          reference: "scene.png",
          note: "",
          prompt: "",
        },
      ],
      characters: [
        {
          id: "C0001",
          name: "旅人",
          description: "",
          image: "traveler.png",
          imagePrompt: "",
          voice: "traveler.wav",
        },
      ],
      castByShot: { S0001: ["C0001"] },
    };

    expect(shotImageInputs(card({ id: "S0001" }), episodeData)).toEqual([
      { reference: "traveler.png", label: "旅人" },
    ]);
  });

  it("shows current materials and restores historical checked states", () => {
    const images = ["frame.png", "scene.png", "alice.png", "spider.png"].map(
      (reference, index) => ({
        reference,
        label: `Picture ${index + 1}`,
      }),
    );
    const audios = [
      { reference: "narrator.wav", label: "Audio 1" },
      { reference: "alice.wav", label: "Audio 2" },
    ];

    expect(
      regenerationSelections(images, audios, {
        imageRefs: ["frame.png", "scene.png", "spider.png"],
        audioRefs: ["narrator.wav"],
      }),
    ).toEqual({
      images: [true, true, false, true],
      audios: [true, false],
    });

    expect(
      regenerationSelections(images, audios, {
        imageRefs: [],
        audioRefs: [],
      }),
    ).toEqual({
      images: [true, true, true, true],
      audios: [true, true],
    });
  });

  it("reuses recorded generation references and falls back for legacy history", () => {
    expect(
      replayGenerationReferences(
        { imageRefs: ["chosen-frame.png"], audioRefs: [] },
        ["current-frame.png"],
        ["current-voice.wav"],
      ),
    ).toEqual({ imageRefs: ["chosen-frame.png"], audioRefs: [] });

    expect(
      replayGenerationReferences(
        { imageRefs: [], audioRefs: [] },
        ["current-frame.png", "current-role.png"],
        ["current-voice.wav"],
      ),
    ).toEqual({
      imageRefs: ["current-frame.png", "current-role.png"],
      audioRefs: ["current-voice.wav"],
    });
  });

  it("removes an unchecked declaration and compacts later picture labels", () => {
    const prepared = prepareGenerationSelection(
      "<Picture 1>：首帧。\n<Picture 2>：场景。\n<Picture 3>：艾莉丝外貌。\n<Picture 4>：蜘蛛外貌。\n\n蜘蛛沿小径走出。",
      ["frame.png", "scene.png", "alice.png", "spider.png"].map(
        (reference, index) => ({ reference, label: `Picture ${index + 1}` }),
      ),
      [],
      [true, true, false, true],
      [],
    );

    expect(prepared.imageRefs).toEqual([
      "frame.png",
      "scene.png",
      "spider.png",
    ]);
    expect(prepared.prompt).toContain("<Picture 3>：蜘蛛外貌。");
    expect(prepared.prompt).not.toContain("艾莉丝外貌");
    expect(prepared.prompt).not.toContain("<Picture 4>");
    expect(generationPromptIssues(prepared.prompt, 3, 0)).toEqual([]);
  });

  it("marks references that remain after their material is unchecked", () => {
    const prepared = prepareGenerationSelection(
      "<Picture 1>：首帧。\n<Picture 2>：艾莉丝外貌。\n艾莉丝外貌沿用<Picture 2>。",
      [
        { reference: "frame.png", label: "Picture 1" },
        { reference: "alice.png", label: "Picture 2" },
      ],
      [],
      [true, false],
      [],
    );

    expect(prepared.prompt).toContain("艾莉丝外貌沿用⟦已取消 Picture 2⟧");
    expect(generationPromptIssues(prepared.prompt, 1, 0)).toEqual([
      { tag: "<Picture 2>", kind: "cancelled-reference" },
    ]);
  });

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
