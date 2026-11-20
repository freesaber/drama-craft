import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  batchGenerationCandidates,
  batchItemResolution,
  batchResolutionOptions,
} from "./batchGeneration";
import { documentTemplate } from "./markdown";
import { parseStoryboard } from "./storyboard";
import { autodlApiProfile, AUTODL_RESOLUTION_PRESETS } from "./videoWorkflows";
import { ui } from "./i18n";

const active = {
  ...autodlApiProfile("active", AUTODL_RESOLUTION_PRESETS[0]),
  name: "当前生成配置",
};
const historical = {
  ...autodlApiProfile("historical", AUTODL_RESOLUTION_PRESETS[1]),
  name: "旧版生成配置",
};
const settings = {
  profiles: [active, historical],
  activeProfileId: active.id,
  defaultResolution: "480p横",
};

const fixture = () =>
  parseStoryboard(documentTemplate("episode", "01 测试.md"));

afterEach(() => vi.restoreAllMocks());

describe("batch generation candidates", () => {
  it("keeps every shot, including missing frames and existing videos; ignores planned filenames", async () => {
    const board = fixture();
    const first = board.cards[0];
    first.fields.resolution.value = "768p横";
    board.cards = [
      first,
      ...["S0002", "S0003"].map((id) => ({
        ...first,
        id,
        fields: {
          ...first.fields,
          frameFile: { value: `${id}.png` },
          videoFile: { value: `${id}.mp4` },
        },
        videoInputs: [
          {
            param: "ref_image_0",
            tag: "<Picture 1>",
            reference: `${id}.png`,
            kind: "image" as const,
          },
        ],
      })),
    ];
    vi.spyOn(api, "generationVideoSources").mockResolvedValue([]);
    vi.spyOn(api, "media").mockImplementation(
      async (_handle, _document, ref) =>
        ({
          exists:
            (ref.endsWith(".png") && ref !== "S0002.png") ||
            ref === "S0003.mp4",
        }) as Awaited<ReturnType<typeof api.media>>,
    );
    const rows = await batchGenerationCandidates(
      "fixture",
      "01 测试.md",
      board,
      settings,
    );
    expect(rows.map((row) => row.shotId)).toEqual(
      board.cards.map((card) => card.id),
    );
    expect(rows[0]).toMatchObject({
      missing: [],
      hasVideo: false,
      apiName: active.name,
      previousResolution: "",
    });
    expect(rows[0].sourceTaskId).toBeUndefined();
    expect(batchItemResolution(rows[0])).toBe("");
    expect(batchItemResolution(rows[0], "768p横")).toBe("768p横");
    expect(rows[1].missing).toContain("S0002.png");
    expect(rows[2]).toMatchObject({
      missing: [ui.batch.unknownVideoApi],
      hasVideo: true,
    });
  });

  it("recognizes an existing historical video even when the current filename is a placeholder", async () => {
    vi.spyOn(api, "generationVideoSources").mockResolvedValue([
      {
        taskId: "previous",
        localFile: "previous.mp4",
        resolution: "480p横",
        provider: null,
      },
    ]);
    vi.spyOn(api, "media").mockImplementation(
      async (_handle, _document, ref) =>
        ({
          exists: ref.endsWith(".png") || ref === "previous.mp4",
        }) as Awaited<ReturnType<typeof api.media>>,
    );
    const rows = await batchGenerationCandidates(
      "fixture",
      "01 测试.md",
      fixture(),
      settings,
    );
    expect(rows[0]).toMatchObject({
      missing: [ui.batch.selectCurrentVideo],
      hasVideo: true,
    });
  });

  it("uses the selected older video API, not the latest history or active API", async () => {
    const board = fixture();
    const shot = board.cards[0];
    const provider = {
      profileId: historical.id,
      submitUrl: historical.submitUrl,
    };
    shot.fields.videoFile.value = "./selected.mp4";
    shot.fields.resolution.value = "768p横";
    shot.fields.videoPrompt.value = "使用当前分镜提示词。";
    vi.spyOn(api, "generationVideoSources").mockResolvedValue([
      {
        taskId: "latest",
        localFile: "latest.mp4",
        resolution: "768p横",
        provider: { profileId: active.id, submitUrl: active.submitUrl },
      },
      {
        taskId: "selected",
        localFile: "selected.mp4",
        resolution: "480p横(864*480)",
        provider,
      },
    ]);
    vi.spyOn(api, "media").mockImplementation(
      async (_handle, _document, ref) =>
        ({
          exists: true,
          path: ref.replace(/^\.\//, ""),
        }) as Awaited<ReturnType<typeof api.media>>,
    );
    const [row] = await batchGenerationCandidates(
      "fixture",
      "01.md",
      board,
      settings,
    );
    expect(row).toMatchObject({
      hasVideo: true,
      missing: [],
      sourceTaskId: "selected",
      apiName: historical.name,
      prompt: shot.fields.videoPrompt.value,
      previousResolution: "480p横(864*480)",
      seed: 803,
    });
    expect(batchItemResolution(row)).toBe("480p横(864*480)");
    expect(batchItemResolution(row, "768p横")).toBe("768p横(1376*768)");
    expect(batchItemResolution(row, "960p横")).toBe("");
    expect(
      batchResolutionOptions([
        row,
        {
          ...row,
          resolutions: AUTODL_RESOLUTION_PRESETS[0].resolutions.slice(),
        },
      ]),
    ).toEqual(["480p竖", "768p竖", "480p横", "768p横"]);
    const [unavailable] = await batchGenerationCandidates(
      "fixture",
      "01.md",
      board,
      {
        ...settings,
        profiles: [
          active,
          { ...historical, submitUrl: "https://example.test/replacement" },
        ],
      },
    );
    expect(unavailable).toMatchObject({
      missing: [ui.batch.restoreVideoApi],
      apiName: AUTODL_RESOLUTION_PRESETS[1].id,
    });
  });

  it.each(["", "planned-frame.png"])(
    "accepts mapped reference art without using the planned first frame (%j)",
    async (frameFile) => {
      const board = fixture();
      const shot = board.cards[0];
      shot.fields.frameFile.value = frameFile;
      shot.fields.videoPrompt.value = "沿用<Picture 1>中的街道布局。";
      shot.videoInputs = [
        {
          param: "ref_image_0",
          tag: "<Picture 1>",
          reference: "street.png",
          kind: "image",
        },
      ];
      vi.spyOn(api, "generationVideoSources").mockResolvedValue([]);
      const media = vi
        .spyOn(api, "media")
        .mockImplementation(
          async (_handle, _document, ref) =>
            ({ exists: ref === "street.png" }) as Awaited<
              ReturnType<typeof api.media>
            >,
        );
      const rows = await batchGenerationCandidates(
        "fixture",
        "01 测试.md",
        board,
        settings,
      );
      expect(rows[0]).toMatchObject({
        missing: [],
        hasVideo: false,
        prompt: shot.fields.videoPrompt.value,
        imageRefs: ["street.png"],
      });
      expect(media).not.toHaveBeenCalledWith(
        "fixture",
        "01 测试.md",
        frameFile,
      );
    },
  );

  it("keeps incomplete shots visible and reports missing prompt, audio and invalid duration", async () => {
    const board = fixture();
    const shot = board.cards[0];
    shot.fields.frameFile.value = "";
    shot.fields.videoPrompt.value = "";
    shot.fields.duration.value = "16";
    shot.videoInputs.push({
      param: "ref_audio_0",
      tag: "<Audio 1>",
      reference: "voice.wav",
      kind: "audio",
    });
    vi.spyOn(api, "generationVideoSources").mockResolvedValue([]);
    vi.spyOn(api, "media").mockImplementation(
      async (_handle, _document, ref) => {
        if (ref === "voice.wav") throw new Error("unreadable fixture");
        return { exists: ref.endsWith(".png") } as Awaited<
          ReturnType<typeof api.media>
        >;
      },
    );
    const rows = await batchGenerationCandidates(
      "fixture",
      "01 测试.md",
      board,
      settings,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].missing).toEqual([
      ui.batch.missingPrompt,
      ui.batch.invalidDuration,
      "voice.wav",
    ]);
  });

  it("does not count deleted historical video files as existing videos", async () => {
    vi.spyOn(api, "generationVideoSources").mockResolvedValue([
      {
        taskId: "deleted",
        localFile: "deleted.mp4",
        resolution: "480p横",
        provider: null,
      },
    ]);
    vi.spyOn(api, "media").mockImplementation(
      async (_handle, _document, ref) =>
        ({ exists: ref.endsWith(".png") }) as Awaited<
          ReturnType<typeof api.media>
        >,
    );
    const rows = await batchGenerationCandidates(
      "fixture",
      "01 测试.md",
      fixture(),
      settings,
    );
    expect(rows[0]).toMatchObject({ missing: [], hasVideo: false });
  });
});
