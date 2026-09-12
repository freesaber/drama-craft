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
export interface Shot {
  id: string;
  title: string;
  offset: number;
  line: number;
}
