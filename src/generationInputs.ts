import type { EpisodeData, ShotCard } from "./types";

export type InputAsset = { reference: string; label: string };

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
  for (const asset of episode.assets)
    if (
      asset.reference &&
      asset.shots.includes(card.id) &&
      mediaKind(asset.reference) === "image"
    )
      items.push({ reference: asset.reference, label: asset.name });
  for (const entry of card.references)
    if (mediaKind(entry.reference) === "image")
      items.push({
        reference: entry.reference,
        label: "素材",
      });
  return unique(items).slice(0, 9);
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

export function hasVideoReference(card: ShotCard): boolean {
  return Boolean(card.fields.videoFile.value.trim());
}

export function shotGenerationPayload(
  card: ShotCard,
  episode: EpisodeData,
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
  const images = shotImageInputs(card, episode);
  const audios = shotAudioInputs(card, episode);
  const duration = Number(card.fields.duration.value || "5");
  const resolution = card.fields.resolution.value.trim() || "768p竖";
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
