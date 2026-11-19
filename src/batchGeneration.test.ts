import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { batchGenerationCandidates } from "./batchGeneration";
import { documentTemplate } from "./markdown";
import { parseStoryboard } from "./storyboard";
import { FALLBACK_VIDEO_OPTIONS } from "./videoWorkflows";
import { ui } from "./i18n";

const fixture = () =>
  parseStoryboard(documentTemplate("episode", "01 测试.md"));

afterEach(() => vi.restoreAllMocks());

describe("batch generation candidates", () => {
  it("keeps every shot, including missing frames and existing videos; ignores planned filenames", async () => {
    const board = fixture();
    const first = board.cards[0];
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
    vi.spyOn(api, "generationHistory").mockResolvedValue([]);
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
      FALLBACK_VIDEO_OPTIONS,
    );
    expect(rows.map((row) => row.shotId)).toEqual(
      board.cards.map((card) => card.id),
    );
    expect(rows[0]).toMatchObject({ missing: [], hasVideo: false });
    expect(rows[1].missing).toContain("S0002.png");
    expect(rows[2]).toMatchObject({ missing: [], hasVideo: true });
  });

  it("recognizes an existing historical video even when the current filename is a placeholder", async () => {
    vi.spyOn(api, "generationHistory").mockResolvedValue([
      { localFile: "previous.mp4" },
    ] as Awaited<ReturnType<typeof api.generationHistory>>);
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
      FALLBACK_VIDEO_OPTIONS,
    );
    expect(rows[0]).toMatchObject({ missing: [], hasVideo: true });
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
      vi.spyOn(api, "generationHistory").mockResolvedValue([]);
      const media = vi.spyOn(api, "media").mockImplementation(
        async (_handle, _document, ref) =>
          ({ exists: ref === "street.png" }) as Awaited<
            ReturnType<typeof api.media>
          >,
      );
      const rows = await batchGenerationCandidates(
        "fixture",
        "01 测试.md",
        board,
        FALLBACK_VIDEO_OPTIONS,
      );
      expect(rows[0]).toMatchObject({
        missing: [],
        hasVideo: false,
        prompt: shot.fields.videoPrompt.value,
        imageRefs: ["street.png"],
      });
      expect(media).not.toHaveBeenCalledWith("fixture", "01 测试.md", frameFile);
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
    vi.spyOn(api, "generationHistory").mockResolvedValue([]);
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
      FALLBACK_VIDEO_OPTIONS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].missing).toEqual([
      ui.batch.missingPrompt,
      ui.batch.invalidDuration,
      "voice.wav",
    ]);
  });

  it("does not count deleted historical video files as existing videos", async () => {
    vi.spyOn(api, "generationHistory").mockResolvedValue([
      { localFile: "deleted.mp4" },
    ] as Awaited<ReturnType<typeof api.generationHistory>>);
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
      FALLBACK_VIDEO_OPTIONS,
    );
    expect(rows[0]).toMatchObject({ missing: [], hasVideo: false });
  });
});
