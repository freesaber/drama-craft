export interface Project {
  handle: string;
  root: string;
  metadata: { id: string; name: string; formatVersion: number; layout: string };
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
}
export interface ApiProfile {
  id: string;
  name: string;
  baseUrl: string;
  hasAuthorization: boolean;
}
export interface GenerationSettings {
  profiles: ApiProfile[];
  activeProfileId: string;
  defaultResolution: string;
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
  remoteUrl: string | null;
  localFile: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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
  voice: string | null;
  voiceStatus: string;
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
  format: "v1" | "legacy" | "document" | "unsupported";
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
