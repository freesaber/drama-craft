export interface Project {
  handle: string;
  root: string;
  metadata: {
    id: string;
    name: string;
    formatVersion: number;
    layout: string;
    libraries: { characters?: string; voices: string };
  };
  warning: string | null;
}
export interface DocumentEntry {
  path: string;
  name: string;
}
export interface Snapshot {
  text: string;
  hash: string;
  readonly: boolean;
}
export interface Recent {
  name: string;
  path: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface Candidate {
  name: string;
  path: string;
}
export interface Media {
  reference: string;
  path: string | null;
  exists: boolean;
  kind: "image" | "audio" | "video";
  revision?: string | null;
}
export interface FrameVersion {
  id: string;
  archivedReference: string;
  archivedAt: string;
}
export type ApiPlatformType = "autodl";

export interface ApiProfile {
  id: string;
  name: string;
  /** 平台类型；当前仅 AutoDL，预留即梦等 */
  type: ApiPlatformType;
  /** 提交任务完整 URL，无默认 */
  submitUrl: string;
  /** 查询任务 URL，可用 {task_id} 占位；无默认 */
  queryUrl: string;
  /** resolution 下拉选项，JSON 字符串数组 */
  resolutions: string;
  /** 生成面板 seed 默认值 */
  defaultSeed: string;
  hasAuthorization: boolean;
}
export interface GenerationSettings {
  profiles: ApiProfile[];
  activeProfileId: string;
  defaultResolution: string;
}
export type AudioApiPlatformType = "autodl";
export interface AudioApiProfile {
  id: string;
  name: string;
  type: AudioApiPlatformType;
  submitUrl: string;
  queryUrl: string;
  hasAuthorization: boolean;
}
export interface AudioSettings {
  profiles: AudioApiProfile[];
  activeProfileId: string;
}
export interface AudioRecord {
  taskId: string;
  status: string;
  localFile: string | null;
  error: string | null;
}
export interface GenerationInput {
  document: string;
  shotId: string;
  prompt: string;
  duration: number;
  resolution: string;
  seed: number | null;
  imageRefs: string[];
  audioRefs: string[];
}
export interface GenerationRecord {
  taskId: string;
  document: string;
  shotId: string;
  status: string;
  prompt: string;
  duration: number;
  resolution: string;
  seed: number | null;
  imageRefs: string[];
  audioRefs: string[];
  remoteUrl: string | null;
  localFile: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export type BatchJobType = "generation" | "audio" | "merge";
export interface BatchJobItemInput {
  shotId: string;
  shotTitle: string;
  prompt: string;
  duration: number;
  resolution: string;
  seed: number | null;
  imageRefs: string[];
  audioRefs: string[];
}
export interface MergeShotInput {
  shotId: string;
  shotTitle: string;
  localFile: string;
  duration: number;
  resolution: string;
}
export interface MergeEpisodeInput {
  document: string;
  name: string;
  items: MergeShotInput[];
}
export interface CreateBatchJobInput {
  jobType: BatchJobType;
  name: string;
  document: string;
  delayHours: number;
  items: BatchJobItemInput[];
}
export interface BatchJobItem {
  itemId: string;
  jobId: string;
  shotId: string;
  shotTitle: string;
  status: string;
  prompt: string;
  duration: number;
  resolution: string;
  seed: number | null;
  imageRefs: string[];
  audioRefs: string[];
  generationTaskId: string | null;
  submittedAt: string | null;
  localFile: string | null;
  error: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}
export interface BatchJob {
  jobId: string;
  jobType: BatchJobType | string;
  name: string;
  document: string;
  status: string;
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
  itemTotal: number;
  itemCompleted: number;
  itemCancelled: number;
  itemFailed: number;
  items: BatchJobItem[];
  resultFile?: string | null;
}
export interface BatchAdvanceResult {
  submitted: BatchJobItem | null;
  jobs: BatchJob[];
}
export interface Shot {
  id: string;
  title: string;
  offset: number;
  line: number;
  end: number;
  headingEnd: number;
  depth: number;
}

export interface SourceRange {
  start: number;
  end: number;
}
export interface SourceField {
  value: string;
  syntax?: "inline" | "angle" | "url" | "parameter" | "title";
  range?: SourceRange;
  ambiguous?: boolean;
  // Missing fields are inserted only after explicit user editing.
  insertion?: { offset: number; before: string; after: string };
  fence?: { marker: string; info: string };
  padding?: { before: string; after: string };
}
export type BoardField =
  | "title"
  | "story"
  | "framePrompt"
  | "videoPrompt"
  | "duration"
  | "resolution"
  | "frameFile"
  | "videoFile";
export interface ShotCard extends Shot {
  fields: Record<BoardField, SourceField>;
  frameAssets: { label: string; name: string; reference: string }[];
  /** Upload slots from the video-generation mapping table, in document order. */
  videoInputs: {
    param: string;
    tag: string;
    reference: string;
    kind: "image" | "audio";
  }[];
  references: { reference: string; field: SourceField }[];
  diagnostics: string[];
}
export interface Storyboard {
  source: string;
  episode: EpisodeData;
  cards: ShotCard[];
  sections: (
    { kind: "shot"; index: number } | { kind: "document"; range: SourceRange }
  )[];
  diagnostics: string[];
}

export interface CharacterData {
  id: string;
  name: string;
  description: string;
  image: string | null;
  imagePrompt: string;
  voice: string | null;
  shots: string[];
}
export interface EpisodeAsset {
  id: string;
  name: string;
  kind: string;
  reference: string | null;
  shots: string[];
  note: string;
  prompt: string;
}
export interface DialogueData {
  shotId: string;
  characterId: string;
  delivery: string;
  text: string;
  interval: string;
}
export interface EpisodeData {
  format: "v1" | "document" | "unsupported";
  title: string;
  summary: string;
  characters: CharacterData[];
  assets: EpisodeAsset[];
  dialogues: DialogueData[];
  castByShot: Record<string, string[]>;
  diagnostics: string[];
}
export interface SourcePatch {
  source: string;
  range: SourceRange;
  replacement: string;
}
