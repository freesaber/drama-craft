import { api } from "./api";
import {
  generationPromptIssues,
  shotAudioInputs,
  shotGenerationPayload,
  shotImageInputs,
} from "./generationInputs";
import { ui } from "./i18n";
import type { BatchJobItemInput, Storyboard } from "./types";
import type { VideoApiOptions } from "./videoWorkflows";

export type BatchGenerationCandidate = BatchJobItemInput & {
  missing: string[];
  hasVideo: boolean;
};

export async function batchGenerationCandidates(
  handle: string,
  document: string,
  board: Storyboard,
  workflow: VideoApiOptions,
): Promise<BatchGenerationCandidate[]> {
  const exists = async (reference: string) => {
    try {
      return (await api.media(handle, document, reference)).exists;
    } catch {
      return false;
    }
  };
  return Promise.all(
    board.cards.map(async (card) => {
      const payload = shotGenerationPayload(card, board.episode, workflow);
      const imageRefs = shotImageInputs(
        card,
        board.episode,
        workflow.maxImages,
      ).map((item) => item.reference);
      const audioRefs = shotAudioInputs(card, board.episode).map(
        (item) => item.reference,
      );
      const missing: string[] = [];
      if (!card.fields.videoPrompt.value.trim())
        missing.push(ui.batch.missingPrompt);
      if (!imageRefs.length) missing.push(ui.batch.missingImages);
      const duration = Number(card.fields.duration.value || "5");
      if (!Number.isInteger(duration) || duration < 1 || duration > 15)
        missing.push(ui.batch.invalidDuration);
      for (const reference of [...imageRefs, ...audioRefs]) {
        if (!(await exists(reference))) missing.push(reference);
      }
      for (const issue of generationPromptIssues(
        card.fields.videoPrompt.value,
        imageRefs.length,
        audioRefs.length,
      )) {
        missing.push(`${ui.batch.missingPromptReference} ${issue.tag}`);
      }
      const history = await api.generationHistory(handle, document, card.id);
      const videoRefs = new Set(
        [
          card.fields.videoFile.value.trim(),
          ...history.map((record) => record.localFile ?? ""),
        ].filter(Boolean),
      );
      let hasVideo = false;
      for (const reference of videoRefs) {
        if (await exists(reference)) {
          hasVideo = true;
          break;
        }
      }
      return {
        ...(payload ?? {
          shotId: card.id,
          shotTitle: card.title,
          prompt: card.fields.videoPrompt.value.trim(),
          duration,
          resolution:
            card.fields.resolution.value || workflow.defaultResolution,
          seed: null,
          imageRefs,
          audioRefs,
        }),
        missing: [...new Set(missing)],
        hasVideo,
      };
    }),
  );
}
