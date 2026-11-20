import { api } from "./api";
import {
  generationPromptIssues,
  shotAudioInputs,
  shotImageInputs,
} from "./generationInputs";
import { ui } from "./i18n";
import type {
  BatchJobItemInput,
  GenerationSettings,
  Storyboard,
} from "./types";
import {
  alignResolutionOption,
  optionsFromProfile,
  profileForVideoBinding,
  resolutionLabelKey,
  videoApiName,
} from "./videoWorkflows";

export type BatchGenerationCandidate = Omit<BatchJobItemInput, "resolution"> & {
  missing: string[];
  hasVideo: boolean;
  apiName: string;
  previousResolution: string;
  resolutions: string[];
};

export function batchItemResolution(
  item: Pick<BatchGenerationCandidate, "previousResolution" | "resolutions">,
  override = "",
): string {
  return (
    alignResolutionOption(
      override || item.previousResolution,
      item.resolutions,
    ) ?? ""
  );
}

export function batchResolutionOptions(
  items: readonly BatchGenerationCandidate[],
): string[] {
  const first = items[0];
  if (!first) return [];
  const labels = first.resolutions.map(resolutionLabelKey);
  return [...new Set(labels)].filter((label) =>
    items.every((item) => alignResolutionOption(label, item.resolutions)),
  );
}

export async function batchGenerationCandidates(
  handle: string,
  document: string,
  board: Storyboard,
  settings: GenerationSettings,
): Promise<BatchGenerationCandidate[]> {
  const active = settings.profiles.find(
    (profile) => profile.id === settings.activeProfileId,
  );
  const media = async (reference: string) => {
    if (!reference) return null;
    try {
      const entry = await api.media(handle, document, reference);
      return entry.exists ? entry : null;
    } catch {
      return null;
    }
  };
  return Promise.all(
    board.cards.map(async (card) => {
      const currentRef = card.fields.videoFile.value.trim();
      const [current, history] = await Promise.all([
        media(currentRef),
        api.generationVideoSources(handle, document, card.id),
      ]);
      const sources = current
        ? history.filter((record) => record.localFile === currentRef)
        : [];
      let hasVideo = Boolean(current);
      if (!hasVideo || !sources.length) {
        for (const record of history) {
          const file = await media(record.localFile);
          if (!file) continue;
          hasVideo = true;
          if (!current) break;
          if (current.path && file.path === current.path) sources.push(record);
        }
      }
      const source = sources[0];
      const binding = source?.provider;
      const missing: string[] = [];
      const submitUrl = hasVideo
        ? (binding?.submitUrl ?? "")
        : (active?.submitUrl ?? "");
      let profile = active;
      if (hasVideo) {
        profile = profileForVideoBinding(settings.profiles, binding);
        if (!current) missing.push(ui.batch.selectCurrentVideo);
        else if (
          !submitUrl ||
          sources.some((record) => record.provider?.submitUrl !== submitUrl)
        ) {
          missing.push(ui.batch.unknownVideoApi);
        } else if (!profile) missing.push(ui.batch.restoreVideoApi);
      } else if (!submitUrl) missing.push(ui.batch.configureVideoApi);
      const workflow = optionsFromProfile(profile);
      if (profile && !workflow.resolutions.length)
        missing.push(ui.batch.configureVideoResolution);
      const imageRefs = shotImageInputs(
        card,
        board.episode,
        workflow.maxImages,
      ).map((item) => item.reference);
      const audioRefs = shotAudioInputs(card, board.episode).map(
        (item) => item.reference,
      );
      const prompt = card.fields.videoPrompt.value.trim();
      if (!prompt) missing.push(ui.batch.missingPrompt);
      if (!imageRefs.length) missing.push(ui.batch.missingImages);
      const duration = Number(card.fields.duration.value || "5");
      if (!Number.isInteger(duration) || duration < 1 || duration > 15)
        missing.push(ui.batch.invalidDuration);
      for (const reference of [...imageRefs, ...audioRefs]) {
        if (!(await media(reference))) missing.push(reference);
      }
      for (const issue of generationPromptIssues(
        prompt,
        imageRefs.length,
        audioRefs.length,
      )) {
        missing.push(`${ui.batch.missingPromptReference} ${issue.tag}`);
      }
      return {
        shotId: card.id,
        shotTitle: card.title,
        prompt,
        duration,
        seed: workflow.defaultSeed ? Number(workflow.defaultSeed) : null,
        imageRefs,
        audioRefs,
        missing: [...new Set(missing)],
        hasVideo,
        sourceTaskId: source?.taskId,
        apiName: videoApiName(submitUrl, profile),
        previousResolution: source?.resolution ?? "",
        resolutions: workflow.resolutions,
      };
    }),
  );
}
