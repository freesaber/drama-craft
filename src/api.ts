import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BatchAdvanceResult,
  BatchJob,
  Candidate,
  CreateBatchJobInput,
  MergeEpisodeInput,
  DocumentEntry,
  GenerationInput,
  GenerationRecord,
  GenerationSettings,
  Media,
  Project,
  Recent,
  Snapshot,
} from "./types";
import { ui } from "./i18n";
export const desktop = isTauri();
export const api = {
  inspect: (path: string) => invoke<Candidate[]>("inspect_directory", { path }),
  open: (path: string, characterDirectory?: string, voiceDirectory?: string) =>
    invoke<Project>("open_project", {
      path,
      characterDirectory,
      voiceDirectory,
    }),
  close: (handle: string) => invoke<void>("close_project", { handle }),
  create: (
    parent: string,
    name: string,
    characterDirectory: string | undefined,
    voiceDirectory: string,
  ) =>
    invoke<Project>("create_project", {
      parent,
      name,
      characterDirectory,
      voiceDirectory,
    }),
  scan: (handle: string) =>
    invoke<{ documents: DocumentEntry[]; warnings: string[] }>("scan_project", {
      handle,
    }),
  read: (handle: string, path: string) =>
    invoke<Snapshot>("read_document", { handle, path }),
  save: (handle: string, path: string, text: string, expectedHash: string) =>
    invoke<Snapshot>("save_document", { handle, path, text, expectedHash }),
  media: (handle: string, document: string, reference: string) =>
    invoke<Media>("resolve_media", { handle, document, reference }),
  placeDocumentMedia: (
    handle: string,
    document: string,
    reference: string,
    source: string,
  ) =>
    invoke<Media>("place_document_media", {
      handle,
      document,
      reference,
      source,
    }),
  openMedia: (handle: string, document: string, reference: string) =>
    invoke<void>("open_media", { handle, document, reference }),
  preferences: () =>
    invoke<{ recent: Recent[]; previewVisible?: boolean }>("get_preferences"),
  removeRecent: (path: string) =>
    invoke<{ recent: Recent[] }>("remove_recent", { path }),
  defaultVoiceDirectory: () => invoke<string>("default_voice_directory"),
  openDirectory: (path: string) => invoke<void>("open_directory", { path }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  setPreview: (visible: boolean) =>
    invoke<void>("set_preview_visible", { visible }),
  generationSettings: () =>
    invoke<GenerationSettings>("get_generation_settings"),
  generationAuthorization: (profileId: string) =>
    invoke<string>("get_generation_authorization", { profileId }),
  setGenerationSettings: (
    configuration: GenerationSettings,
    authorizations: Record<string, string>,
  ) =>
    invoke<GenerationSettings>("set_generation_settings", {
      configuration,
      authorizations,
    }),
  submitGeneration: (handle: string, input: GenerationInput) =>
    invoke<GenerationRecord>("submit_generation", { handle, input }),
  pollGeneration: (handle: string, taskId: string) =>
    invoke<GenerationRecord>("poll_generation", { handle, taskId }),
  generationHistory: (handle: string, document: string, shotId: string) =>
    invoke<GenerationRecord[]>("generation_history", {
      handle,
      document,
      shotId,
    }),
  importGenerationMedia: (
    handle: string,
    document: string,
    source: string,
    shotId: string,
    slot: string,
  ) =>
    invoke<string>("import_generation_media", {
      handle,
      document,
      source,
      shotId,
      slot,
    }),
  trimMedia: (
    handle: string,
    document: string,
    reference: string,
    start: number,
    end: number,
  ) =>
    invoke<Media>("trim_media", {
      handle,
      document,
      reference,
      start,
      end,
    }),
  createBatchJob: (handle: string, input: CreateBatchJobInput) =>
    invoke<BatchJob>("create_batch_job", { handle, input }),
  mergeEpisode: (handle: string, input: MergeEpisodeInput) =>
    invoke<BatchJob>("merge_episode", { handle, input }),
  listBatchJobs: (handle: string) =>
    invoke<BatchJob[]>("list_batch_jobs", { handle }),
  getBatchJob: (handle: string, jobId: string) =>
    invoke<BatchJob>("get_batch_job", { handle, jobId }),
  cancelBatchJob: (handle: string, jobId: string) =>
    invoke<BatchJob>("cancel_batch_job", { handle, jobId }),
  cancelBatchJobItem: (handle: string, itemId: string) =>
    invoke<BatchJob>("cancel_batch_job_item", { handle, itemId }),
  syncBatchJobs: (handle: string) =>
    invoke<BatchJob[]>("sync_batch_jobs", { handle }),
  advanceBatchJobs: (handle: string) =>
    invoke<BatchAdvanceResult>("advance_batch_jobs", { handle }),
};
export async function chooseDirectory(): Promise<string | null> {
  if (!desktop) return null;
  const path = await open({
    directory: true,
    multiple: false,
    title: ui.choose,
  });
  return typeof path === "string" ? path : null;
}
export async function chooseMedia(
  kind: "image" | "audio",
): Promise<string | null> {
  if (!desktop) return null;
  const path = await open({
    directory: false,
    multiple: false,
    title: kind === "image" ? "选择参考图片" : "选择参考音频",
    filters: [
      kind === "image"
        ? { name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }
        : { name: "音频", extensions: ["mp3", "wav", "flac", "mp4"] },
    ],
  });
  return typeof path === "string" ? path : null;
}
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return typeof error === "string" ? error : ui.errors.unknown;
}
