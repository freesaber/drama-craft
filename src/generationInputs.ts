import type { EpisodeData, ShotCard } from "./types";
import { matchConfiguredResolution } from "./videoWorkflows";

export type InputAsset = { reference: string; label: string };

export interface PreparedGenerationSelection {
  prompt: string;
  imageRefs: string[];
  audioRefs: string[];
}

export interface GenerationPromptIssue {
  tag: string;
  kind: "cancelled-reference" | "missing-reference";
}

export function replayGenerationReferences(
  recorded: {
    imageRefs?: string[] | null;
    audioRefs?: string[] | null;
  },
  fallbackImageRefs: string[],
  fallbackAudioRefs: string[],
) {
  // Every valid video request has at least one image. An empty/missing image
  // list therefore identifies history written before input references were
  // recorded (or an unreadable legacy value). In that case both lists must be
  // rebuilt together from the current shot. A recorded empty audio list is
  // intentional and must remain empty.
  if (!Array.isArray(recorded.imageRefs) || !recorded.imageRefs.length) {
    return {
      imageRefs: fallbackImageRefs,
      audioRefs: fallbackAudioRefs,
    };
  }
  return {
    imageRefs: recorded.imageRefs,
    audioRefs: Array.isArray(recorded.audioRefs)
      ? recorded.audioRefs
      : fallbackAudioRefs,
  };
}

export function regenerationSelections(
  images: InputAsset[],
  audios: InputAsset[],
  recorded: {
    imageRefs?: string[] | null;
    audioRefs?: string[] | null;
  },
) {
  const references = replayGenerationReferences(
    recorded,
    images.map((item) => item.reference),
    audios.map((item) => item.reference),
  );
  const selectedImages = new Set(references.imageRefs);
  const selectedAudios = new Set(references.audioRefs);
  return {
    images: images.map(
      (item, index) => index === 0 || selectedImages.has(item.reference),
    ),
    audios: audios.map((item) => selectedAudios.has(item.reference)),
  };
}

function sourceSlot(
  item: InputAsset,
  kind: "Picture" | "Audio",
  index: number,
) {
  const match = new RegExp(`${kind}\\s*(\\d+)`, "i").exec(item.label);
  return match ? Number(match[1]) : index + 1;
}

function tagPattern(kind: "Picture" | "Audio", slot: number, flags: string) {
  return new RegExp(`<${kind}\\s*${slot}>`, flags);
}

function prepareReferences(
  prompt: string,
  items: InputAsset[],
  selected: readonly boolean[],
  kind: "Picture" | "Audio",
) {
  const entries = items.map((item, index) => ({
    item,
    selected: selected[index] !== false,
    oldSlot: sourceSlot(item, kind, index),
    placeholder: `\uE000${kind}-${index}\uE001`,
  }));
  let nextPrompt = prompt;

  for (const entry of entries.filter((item) => item.selected)) {
    nextPrompt = nextPrompt.replace(
      tagPattern(kind, entry.oldSlot, "gi"),
      entry.placeholder,
    );
  }

  for (const entry of entries.filter((item) => !item.selected)) {
    const declaration = new RegExp(
      `^[ \\t]*<${kind}\\s*${entry.oldSlot}>[ \\t]*[：:].*(?:\\r?\\n|$)`,
      "gim",
    );
    nextPrompt = nextPrompt.replace(declaration, "");
    nextPrompt = nextPrompt.replace(
      tagPattern(kind, entry.oldSlot, "gi"),
      `⟦已取消 ${kind} ${entry.oldSlot}⟧`,
    );
  }

  const kept = entries.filter((item) => item.selected);
  kept.forEach((entry, index) => {
    nextPrompt = nextPrompt.replaceAll(
      entry.placeholder,
      `<${kind} ${index + 1}>`,
    );
  });

  return {
    prompt: nextPrompt,
    references: kept.map((entry) => entry.item.reference),
  };
}

export function prepareGenerationSelection(
  prompt: string,
  images: InputAsset[],
  audios: InputAsset[],
  selectedImages: readonly boolean[],
  selectedAudios: readonly boolean[],
): PreparedGenerationSelection {
  const imageResult = prepareReferences(
    prompt,
    images,
    selectedImages,
    "Picture",
  );
  const audioResult = prepareReferences(
    imageResult.prompt,
    audios,
    selectedAudios,
    "Audio",
  );
  return {
    prompt: audioResult.prompt.replace(/\n{3,}/g, "\n\n").trim(),
    imageRefs: imageResult.references,
    audioRefs: audioResult.references,
  };
}

export function generationPromptIssues(
  prompt: string,
  imageCount: number,
  audioCount: number,
): GenerationPromptIssue[] {
  const issues: GenerationPromptIssue[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(/⟦已取消 (Picture|Audio) (\d+)⟧/g)) {
    const tag = `<${match[1]} ${match[2]}>`;
    const key = `cancelled:${tag}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push({ tag, kind: "cancelled-reference" });
    }
  }
  for (const match of prompt.matchAll(/<(Picture|Audio)\s*(\d+)>/gi)) {
    const kind = /^picture$/i.test(match[1]) ? "Picture" : "Audio";
    const slot = Number(match[2]);
    const count = kind === "Picture" ? imageCount : audioCount;
    if (slot >= 1 && slot <= count) continue;
    const tag = `<${kind} ${slot}>`;
    const key = `missing:${tag}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push({ tag, kind: "missing-reference" });
    }
  }
  return issues;
}

export function mediaKind(
  reference: string,
): "image" | "audio" | "video" | null {
  const clean = reference.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(clean)) return "image";
  if (/\.(mp3|wav|flac)$/.test(clean)) return "audio";
  if (/\.mp4$/.test(clean)) return "video";
  return null;
}

function unique(items: InputAsset[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.reference || seen.has(item.reference)) return false;
    seen.add(item.reference);
    return true;
  });
}

export function shotImageInputs(
  card: ShotCard,
  episode: EpisodeData,
  maxImages = 9,
): InputAsset[] {
  if (card.videoInputs.length)
    return card.videoInputs
      .filter((item) => item.kind === "image")
      .map((item) => ({
        reference: item.reference,
        label:
          /Picture\s*\d+/i.exec(item.tag)?.[0]?.replace(/\s+/g, " ") ??
          item.param,
      }));
  const cast = new Set(episode.castByShot[card.id] ?? []);
  const items: InputAsset[] = [];
  const frame = card.fields.frameFile.value.trim();
  if (frame) items.push({ reference: frame, label: "首帧" });
  for (const role of episode.characters)
    if (cast.has(role.id) && role.image)
      items.push({ reference: role.image, label: role.name });
  for (const entry of card.references)
    if (mediaKind(entry.reference) === "image")
      items.push({
        reference: entry.reference,
        label: "素材",
      });
  return unique(items).slice(0, maxImages);
}

export function shotAudioInputs(
  card: ShotCard,
  episode: EpisodeData,
): InputAsset[] {
  if (card.videoInputs.length)
    return card.videoInputs
      .filter((item) => item.kind === "audio")
      .map((item) => ({
        reference: item.reference,
        label:
          /Audio\s*\d+/i.exec(item.tag)?.[0]?.replace(/\s+/g, " ") ??
          item.param,
      }));
  const cast = new Set(episode.castByShot[card.id] ?? []);
  const items: InputAsset[] = [];
  for (const role of episode.characters)
    if (cast.has(role.id) && role.voice)
      items.push({ reference: role.voice, label: role.name });
  for (const entry of card.references)
    if (mediaKind(entry.reference) === "audio")
      items.push({
        reference: entry.reference,
        label: "声音",
      });
  return unique(items).slice(0, 3);
}

/** Planned `视频文件名` is always filled in v1 episodes; only an on-disk file counts. */
export function hasSelectedVideo(
  card: ShotCard,
  videoExists: boolean,
): boolean {
  return Boolean(card.fields.videoFile.value.trim()) && videoExists;
}

export function shotGenerationPayload(
  card: ShotCard,
  episode: EpisodeData,
  options: {
    maxImages?: number;
    defaultResolution?: string;
    resolutions?: readonly string[];
  } = {},
): {
  shotId: string;
  shotTitle: string;
  prompt: string;
  duration: number;
  resolution: string;
  seed: number | null;
  imageRefs: string[];
  audioRefs: string[];
} | null {
  const prompt = card.fields.videoPrompt.value.trim();
  const images = shotImageInputs(card, episode, options.maxImages ?? 9);
  const audios = shotAudioInputs(card, episode);
  const duration = Number(card.fields.duration.value || "5");
  const resolution = matchConfiguredResolution(
    card.fields.resolution.value,
    options.resolutions ?? [],
    options.defaultResolution || "480p横(864*480)",
  );
  if (!prompt || !images.length) return null;
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) return null;
  return {
    shotId: card.id,
    shotTitle: card.title,
    prompt,
    duration,
    resolution,
    seed: null,
    imageRefs: images.map((item) => item.reference),
    audioRefs: audios.map((item) => item.reference),
  };
}
