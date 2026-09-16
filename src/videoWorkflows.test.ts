import { describe, expect, it } from "vitest";
import {
  AUTODL_RESOLUTION_PRESETS,
  autodlPresetValues,
  detectAutodlPreset,
  fillEmptyAutodlPreset,
  compactResolutionsJson,
  formatResolutionsJson,
  migrateApiProfile,
  migrateGenerationSettings,
  optionsFromProfile,
  parseResolutionsJson,
} from "./videoWorkflows";

describe("videoWorkflows", () => {
  it("parses resolution JSON lists", () => {
    const compact = formatResolutionsJson(AUTODL_RESOLUTION_PRESETS[0].resolutions);
    expect(parseResolutionsJson(compact)).toEqual([
      ...AUTODL_RESOLUTION_PRESETS[0].resolutions,
    ]);
    expect(compactResolutionsJson(`[\n  "480p横(864*480)"\n]`)).toBe(
      '["480p横(864*480)"]',
    );
  });

  it("detects autodl presets from profile name or submit url", () => {
    expect(
      detectAutodlPreset({
        name: "minimax_h3_z0903",
        submitUrl: "",
      })?.id,
    ).toBe("minimax_h3_z0903");
    expect(
      autodlPresetValues({
        type: "autodl",
        name: "A",
        submitUrl:
          "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24",
        resolutions: "",
        defaultSeed: "",
      })?.defaultSeed,
    ).toBe("683072603085674");
  });

  it("does not overwrite saved autodl preset fields", () => {
    const saved = fillEmptyAutodlPreset({
      id: "1",
      name: "minimax_h3_zm_u24",
      type: "autodl",
      submitUrl:
        "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24",
      queryUrl: "https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}",
      resolutions: '["768p横(1376*768)"]',
      defaultSeed: "999",
      hasAuthorization: true,
    });
    expect(saved.resolutions).toBe('["768p横(1376*768)"]');
    expect(saved.defaultSeed).toBe("999");
  });

  it("builds options from configured profile", () => {
    const options = optionsFromProfile({
      id: "1",
      name: "z0903",
      type: "autodl",
      submitUrl: "https://example.test/submit",
      queryUrl: "https://example.test/result/{task_id}",
      resolutions: formatResolutionsJson(
        AUTODL_RESOLUTION_PRESETS[1].resolutions,
      ),
      defaultSeed: AUTODL_RESOLUTION_PRESETS[1].defaultSeed,
      hasAuthorization: true,
    });
    expect(options.resolutions).toContain("1080p横(1920*1088)");
    expect(options.defaultSeed).toBe("757947932117433");
  });

  it("migrates legacy baseUrl profiles", () => {
    const profile = migrateApiProfile({
      id: "legacy",
      name: "旧",
      baseUrl:
        "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_z0903",
      hasAuthorization: true,
    });
    expect(profile.type).toBe("autodl");
    expect(profile.submitUrl).toContain("minimax_h3_z0903");
    expect(profile.queryUrl).toContain("{task_id}");
    expect(parseResolutionsJson(profile.resolutions)).toContain(
      "1080p横(1920*1088)",
    );
    expect(profile.defaultSeed).toBe("757947932117433");
  });

  it("migrates generation settings payload", () => {
    const settings = migrateGenerationSettings({
      activeProfileId: "a",
      profiles: [
        {
          id: "a",
          name: "A",
          baseUrl: "https://autodl.art",
          hasAuthorization: false,
        },
      ],
    });
    expect(settings.profiles[0].submitUrl).toBe("https://autodl.art");
    expect(settings.profiles[0].queryUrl).toContain("result/{task_id}");
  });
});
