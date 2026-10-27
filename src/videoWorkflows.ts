import type { ApiProfile, ApiPlatformType, GenerationSettings } from "./types";

export const API_PLATFORM_TYPES: { id: ApiPlatformType; label: string }[] = [
  { id: "autodl", label: "AutoDL" },
];

const RES_480P_H = "480p横(864*480)";
const RES_480P_V = "480p竖(480*864)";
const RES_768P_H = "768p横(1376*768)";
const RES_768P_V = "768p竖(768*1376)";
const RES_1440P_V = "1440p竖(1440*2560)";
const RES_1440P_H = "1440p横(2560*1440)";

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

/** Strip pixel suffix so `480p横` and `480p横(864*480)` share a key. */
export function resolutionLabelKey(value: string): string {
  const shot = value.trim();
  const index = shot.search(/[(（]/);
  return (index >= 0 ? shot.slice(0, index) : shot).trim();
}

/**
 * Map a stored label onto the current API list when they share a key.
 * Returns null when the value cannot be uniquely aligned.
 */
export function alignResolutionOption(
  value: string,
  resolutions: readonly string[],
): string | null {
  const shot = value.trim();
  const list = resolutions.map((item) => item.trim()).filter(Boolean);
  if (!shot || !list.length) return null;
  const exact = list.find((item) => item === shot);
  if (exact) return exact;
  const key = resolutionLabelKey(shot);
  if (!key) return null;
  const keyed = list.filter((item) => resolutionLabelKey(item) === key);
  if (keyed.length === 1) return keyed[0];
  if (keyed.length > 1)
    return keyed.find((item) => /[(（]/.test(item)) ?? keyed[0];
  return null;
}

/** Map a document label like `480p横` onto the current API resolution list. */
export function matchConfiguredResolution(
  value: string,
  resolutions: readonly string[],
  fallback = "",
): string {
  const shot = value.trim();
  const list = resolutions.map((item) => item.trim()).filter(Boolean);
  if (!list.length) return shot || fallback;
  if (!shot) return fallback || list[0];
  return alignResolutionOption(shot, list) ?? (fallback || list[0]);
}

/** AutoDL 工作流各自的 resolution / seed 预设。 */
export const AUTODL_RESOLUTION_PRESETS = [
  {
    id: "minimax_h3_zm_u30",
    label: "minimax_h3_zm_u30",
    resolutions: ["480p横", "480p竖", "768p横", "768p竖", "960p横", "960p竖"],
    defaultSeed: "548628410878779",
  },
  {
    id: "minimax_h3_803",
    label: "minimax_h3_803",
    resolutions: [
      RES_480P_V,
      RES_768P_V,
      "1088p竖(1088*1920)",
      RES_1440P_V,
      RES_480P_H,
      RES_768P_H,
      "1088p横(1920*1088)",
      RES_1440P_H,
    ],
    defaultSeed: "803",
  },
] as const;

export type AutodlPreset = (typeof AUTODL_RESOLUTION_PRESETS)[number];

export function autodlApiProfile(id: string, preset: AutodlPreset): ApiProfile {
  return {
    ...emptyApiProfile(id, preset.label),
    submitUrl: `https://autodl.art/api/v1/comfyui/comfyui_workflow/${preset.id}`,
    queryUrl:
      "https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}",
    resolutions: formatResolutionsJson(preset.resolutions),
    defaultSeed: preset.defaultSeed,
  };
}

export interface VideoApiOptions {
  resolutions: string[];
  defaultResolution: string;
  defaultSeed: string;
  maxImages: number;
  maxAudios: number;
}

export const FALLBACK_VIDEO_OPTIONS: VideoApiOptions = {
  resolutions: [...AUTODL_RESOLUTION_PRESETS[0].resolutions],
  defaultResolution: "480p横",
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
    defaultResolution:
      resolutions[0] ?? FALLBACK_VIDEO_OPTIONS.defaultResolution,
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
  if (!resolutions.trim() && submitUrl) {
    const preset =
      detectAutodlPreset({ name: "", submitUrl }) ?? AUTODL_RESOLUTION_PRESETS[0];
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
