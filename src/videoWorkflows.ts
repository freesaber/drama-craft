import type { ApiProfile, ApiPlatformType, GenerationSettings } from "./types";

export const API_PLATFORM_TYPES: { id: ApiPlatformType; label: string }[] = [
  { id: "autodl", label: "AutoDL" },
];

const RES_480P_H = "480p横(864*480)";
const RES_480P_V = "480p竖(480*864)";
const RES_768P_H = "768p横(1376*768)";
const RES_768P_V = "768p竖(768*1376)";
const RES_1080P_V = "1080p竖(1080*1920)";
const RES_1080P_H = "1080p横(1920*1088)";
const RES_1440P_V = "1440p竖(1440*2560)";
const RES_1440P_H = "1440p横(2560*1440)";
const RES_480P_11 = "480p(1:1)(480*480)";
const RES_768P_11 = "768p(1:1)(768*768)";

export function formatResolutionsJson(values: readonly string[]): string {
  return JSON.stringify([...values]);
}

export function compactResolutionsJson(raw: string): string {
  if (!raw.trim()) return "";
  try {
    return formatResolutionsJson(parseResolutionsJson(raw));
  } catch {
    return raw.trim();
  }
}

export function parseResolutionsJson(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error("resolution 须为 JSON 数组");
  const values = parsed.map((item) => {
    if (typeof item !== "string" || !item.trim())
      throw new Error("resolution 列表每一项须为非空字符串");
    return item.trim();
  });
  return [...new Set(values)];
}

export function tryParseResolutionsJson(raw: string): string[] {
  try {
    return parseResolutionsJson(raw);
  } catch {
    return [];
  }
}

/** AutoDL 两套可一键填入的 resolution / seed 预设（不填接口地址） */
export const AUTODL_RESOLUTION_PRESETS = [
  {
    id: "minimax_h3_zm_u24",
    label: "minimax_h3_zm_u24",
    resolutions: [
      RES_480P_H,
      RES_480P_V,
      RES_768P_H,
      RES_768P_V,
      RES_480P_11,
      RES_768P_11,
    ],
    defaultSeed: "683072603085674",
  },
  {
    id: "minimax_h3_z0903",
    label: "minimax_h3_z0903",
    resolutions: [
      RES_480P_V,
      RES_480P_H,
      RES_768P_V,
      RES_768P_H,
      RES_1080P_V,
      RES_1080P_H,
      RES_1440P_V,
      RES_1440P_H,
    ],
    defaultSeed: "757947932117433",
  },
] as const;

export interface VideoApiOptions {
  resolutions: string[];
  defaultResolution: string;
  defaultSeed: string;
  maxImages: number;
  maxAudios: number;
}

export const FALLBACK_VIDEO_OPTIONS: VideoApiOptions = {
  resolutions: [...AUTODL_RESOLUTION_PRESETS[0].resolutions],
  defaultResolution: RES_480P_H,
  defaultSeed: AUTODL_RESOLUTION_PRESETS[0].defaultSeed,
  maxImages: 9,
  maxAudios: 3,
};

export function detectAutodlPreset(
  profile: Pick<ApiProfile, "name" | "submitUrl">,
) {
  const text = `${profile.name} ${profile.submitUrl}`;
  return (
    AUTODL_RESOLUTION_PRESETS.find((preset) => text.includes(preset.id)) ?? null
  );
}

export function autodlPresetValues(
  profile: Pick<
    ApiProfile,
    "name" | "submitUrl" | "type" | "resolutions" | "defaultSeed"
  >,
): Partial<Pick<ApiProfile, "resolutions" | "defaultSeed">> | null {
  if (profile.type !== "autodl") return null;
  const preset = detectAutodlPreset(profile);
  if (!preset) return null;
  const updates: Partial<Pick<ApiProfile, "resolutions" | "defaultSeed">> = {};
  if (!profile.resolutions.trim()) {
    updates.resolutions = formatResolutionsJson(preset.resolutions);
  }
  if (!profile.defaultSeed.trim()) {
    updates.defaultSeed = preset.defaultSeed;
  }
  return Object.keys(updates).length ? updates : null;
}

export function fillEmptyAutodlPreset(profile: ApiProfile): ApiProfile {
  const preset = autodlPresetValues(profile);
  return preset ? { ...profile, ...preset } : profile;
}

export function emptyApiProfile(
  id: string,
  name: string,
): Omit<ApiProfile, "hasAuthorization"> & { hasAuthorization: false } {
  return {
    id,
    name,
    type: "autodl",
    submitUrl: "",
    queryUrl: "",
    resolutions: "",
    defaultSeed: "",
    hasAuthorization: false,
  };
}

export function optionsFromProfile(
  profile: ApiProfile | undefined,
): VideoApiOptions {
  if (!profile) return FALLBACK_VIDEO_OPTIONS;
  const resolutions = tryParseResolutionsJson(profile.resolutions);
  return {
    resolutions,
    defaultResolution: resolutions[0] ?? FALLBACK_VIDEO_OPTIONS.defaultResolution,
    defaultSeed: profile.defaultSeed.trim(),
    maxImages: 9,
    maxAudios: 3,
  };
}

/** 兼容旧配置：仅有 baseUrl 时迁移为 submit/query */
export function migrateApiProfile(raw: Record<string, unknown>): ApiProfile {
  const id = String(raw.id ?? "");
  const name = String(raw.name ?? "");
  const type = (raw.type as ApiPlatformType) || "autodl";
  const submitUrl = String(raw.submitUrl ?? raw.baseUrl ?? "").trim();
  let queryUrl = String(raw.queryUrl ?? "").trim();
  let resolutions = String(raw.resolutions ?? "");
  let defaultSeed = String(raw.defaultSeed ?? "");
  if (!queryUrl && submitUrl) {
    try {
      const url = new URL(submitUrl);
      queryUrl = `${url.origin}/api/v1/comfyui/comfyui_workflow/result/{task_id}`;
    } catch {
      /* ignore */
    }
  }
  if (!resolutions.trim() && submitUrl.includes("minimax_h3_z0903")) {
    const preset = AUTODL_RESOLUTION_PRESETS[1];
    resolutions = formatResolutionsJson(preset.resolutions);
    if (!defaultSeed) defaultSeed = preset.defaultSeed;
  } else if (!resolutions.trim() && submitUrl) {
    const preset = AUTODL_RESOLUTION_PRESETS[0];
    resolutions = formatResolutionsJson(preset.resolutions);
    if (!defaultSeed) defaultSeed = preset.defaultSeed;
  }
  return {
    id,
    name,
    type,
    submitUrl,
    queryUrl,
    resolutions,
    defaultSeed,
    hasAuthorization: Boolean(raw.hasAuthorization),
  };
}

export function migrateGenerationSettings(raw: unknown): GenerationSettings {
  const data = (raw ?? {}) as {
    profiles?: Record<string, unknown>[];
    activeProfileId?: string;
    defaultResolution?: string;
  };
  const profiles = (data.profiles ?? []).map(migrateApiProfile);
  const active = profiles.find((p) => p.id === data.activeProfileId);
  const options = optionsFromProfile(active);
  return {
    profiles,
    activeProfileId: data.activeProfileId ?? "",
    defaultResolution:
      data.defaultResolution?.trim() || options.defaultResolution,
  };
}
