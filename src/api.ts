import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  BatchAdvanceResult,
  BatchJob,
  AudioRecord,
  AudioSettings,
  Candidate,
  CreateBatchJobInput,
  MergeEpisodeInput,
  DocumentEntry,
  GenerationInput,
  GenerationRecord,
  GenerationSettings,
  Media,
  FrameVersion,
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
  assetIndex: (handle: string) =>
    invoke<string | null>("read_asset_index", { handle }),
  save: (handle: string, path: string, text: string, expectedHash: string) =>
    invoke<Snapshot>("save_document", { handle, path, text, expectedHash }),
  listDiscardedShots: (handle: string, document: string) =>
    invoke<string[]>("list_discarded_shots", { handle, document }),
  setShotDiscarded: (
    handle: string,
    document: string,
    shotId: string,
    discarded: boolean,
  ) =>
    invoke<string[]>("set_shot_discarded", {
      handle,
      document,
      shotId,
      discarded,
    }),
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
  replaceFrameImage: (
    handle: string, document: string, shotId: string, reference: string, source: string,
  ) => invoke<Media>("replace_frame_image", { handle, document, shotId, reference, source }),
  frameImageHistory: (
    handle: string, document: string, shotId: string, reference: string,
  ) => invoke<FrameVersion[]>("frame_image_history", { handle, document, shotId, reference }),
  restoreFrameImage: (
    handle: string, document: string, shotId: string, reference: string, versionId: string,
  ) => invoke<Media>("restore_frame_image", { handle, document, shotId, reference, versionId }),
  openMedia: (handle: string, document: string, reference: string) =>
    invoke<void>("open_media", { handle, document, reference }),
  preferences: () =>
    invoke<{
      recent: Recent[];
      previewVisible?: boolean;
      newProjectDirectories?: {
        parent: string;
        characterDirectory: string | null;
        voiceDirectory: string;
      } | null;
    }>("get_preferences"),
  removeRecent: (path: string) =>
    invoke<{ recent: Recent[] }>("remove_recent", { path }),
  renameRecent: (path: string, name: string, renameFolder: boolean) =>
    invoke<{ recent: Recent[] }>("rename_recent", {
      path,
      name,
      renameFolder,
    }),
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
  audioSettings: () => invoke<AudioSettings>("get_audio_settings"),
  audioAuthorization: (profileId: string) =>
    invoke<string>("get_audio_authorization", { profileId }),
  setAudioSettings: (
    configuration: AudioSettings,
    authorizations: Record<string, string>,
  ) =>
    invoke<AudioSettings>("set_audio_settings", {
      configuration,
      authorizations,
    }),
  pollAudio: (handle: string, taskId: string) =>
    invoke<AudioRecord>("poll_audio", { handle, taskId }),
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
  deleteGeneration: (
    handle: string,
    document: string,
    shotId: string,
    taskId: string,
  ) => invoke<void>("delete_generation", { handle, document, shotId, taskId }),
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
  exportVideoFrame: (
    handle: string,
    document: string,
    reference: string,
    time: number,
    destination: string,
  ) => invoke<void>("export_video_frame", { handle, document, reference, time, destination }),
  exportVideoTailFrame: (
    handle: string,
    document: string,
    reference: string,
    end: number,
    destination: string,
  ) =>
    invoke<void>("export_video_tail_frame", {
      handle,
      document,
      reference,
      end,
      destination,
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
  markBatchVideoApplied: (handle: string, itemId: string, localFile: string) =>
    invoke<void>("mark_batch_video_applied", { handle, itemId, localFile }),
  advanceBatchJobs: (handle: string) =>
    invoke<BatchAdvanceResult>("advance_batch_jobs", { handle }),
  advanceAudioJobs: (handle: string) =>
    invoke<BatchAdvanceResult>("advance_audio_jobs", { handle }),
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
export async function chooseFrameExport(
  defaultName: string,
  title = ui.generation.exportFrame,
): Promise<string | null> {
  if (!desktop) return null;
  return save({
    title,
    defaultPath: defaultName,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
}
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return typeof error === "string" ? error : ui.errors.unknown;
}
