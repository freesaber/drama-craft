import { createEpisodeTemplate } from "./episodeFormat";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import type { Root, Node, PhrasingContent } from "mdast";
import type { DocumentEntry, Shot } from "./types";

export const parser = unified().use(remarkParse).use(remarkGfm);
const mediaExtension =
  /\.(?:png|jpe?g|webp|gif|bmp|mp3|wav|flac|ogg|m4a|mp4|webm|mov)$/i;
export function plain(node: Node): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node)
    return (node.children as PhrasingContent[]).map(plain).join("");
  return "";
}
/** Only root-level, standalone markers are eligible. Never inspect code/table children. */
export function findShots(
  text: string,
  tree = parser.parse(text) as Root,
): Shot[] {
  const markers = tree.children.flatMap((node, index) => {
    if (node.type !== "heading" && node.type !== "paragraph") return [];
    const start = node.position!.start.offset!;
    const end = node.position!.end.offset!;
    const raw = text.slice(start, end);
    if (node.type === "paragraph" && /[\r\n]/.test(raw)) return [];
    const match = /^(S\d+)(?:\s+(.*))?$/i.exec(plain(node));
    if (!match || (node.type === "paragraph" && !/^S\d+(?:\s|$)/i.test(raw)))
      return [];
    return [
      {
        index,
        id: match[1].toUpperCase(),
        title: match[2] ?? "",
        offset: start,
        headingEnd: end,
        line: node.position!.start.line,
        depth: node.type === "heading" ? node.depth : 0,
      },
    ];
  });
  return markers.map((marker, i) => {
    const next = markers[i + 1]?.offset ?? text.length;
    const boundary = tree.children
      .slice(marker.index + 1)
      .find(
        (node) =>
          node.position!.start.offset! < next &&
          node.type === "heading" &&
          node.depth <= (marker.depth || 2),
      );
    return { ...marker, end: boundary?.position!.start.offset ?? next };
  });
}
export function normalizeReference(value: string): string | null {
  let ref = value.trim().replace(/^<|>$/g, "");
  try {
    ref = decodeURIComponent(ref);
  } catch {
    /* Preserve literal percent signs. */
  }
  if (
    !mediaExtension.test(ref) ||
    /^(?:[a-z]+:\/\/|data:|\\\\|\/\/)/i.test(ref)
  )
    return null;
  return ref;
}
export function analyzeMarkdown(text: string): {
  shots: Shot[];
  references: string[];
  diagnostics: string[];
} {
  const tree = parser.parse(text) as Root;
  const shots = findShots(text, tree);
  const references = new Set<string>();
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const shot of shots) {
    if (seen.has(shot.id))
      diagnostics.push(`镜号 ${shot.id} 重复；请核对标题。`);
    seen.add(shot.id);
  }
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node) => {
    definitions.set(node.identifier, node.url);
  });
  const addReference = (value: string) => {
    const ref = normalizeReference(value);
    if (ref) references.add(ref);
  };
  visit(tree, (node) => {
    if (node.type === "link" || node.type === "image") addReference(node.url);
    if (node.type === "inlineCode") addReference(node.value);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const ref = definitions.get(node.identifier);
      if (ref) addReference(ref);
    }
  });
  return { shots, references: [...references], diagnostics };
}
export function sortDocuments(documents: DocumentEntry[]): DocumentEntry[] {
  const rank = (name: string) =>
    name === "剧本大纲.md"
      ? 0
      : name === "分镜总表.md"
        ? 1
        : /^\d+/.test(name)
          ? 2
          : 3;
  return [...documents].sort(
    (a, b) =>
      rank(a.name) - rank(b.name) ||
      a.path.localeCompare(b.path, "zh-CN", { numeric: true }),
  );
}
export function isOverviewDocument(path: string): boolean {
  const filename = path.split(/[\\/]/).at(-1);
  return filename === "剧本大纲.md" || filename === "分镜总表.md";
}
export function documentTemplate(
  kind: string,
  filename: string,
  defaultResolution = "480p横",
): string {
  const title = filename.replace(/\.md$/i, "");
  if (kind === "outline")
    return `# ${title}\n\n## 故事背景\n\n## 人物与目标\n\n## 完整故事\n\n## 分集规划\n`;
  if (kind === "table")
    return `# ${title}\n\n| 镜号 | 集 | 镜头名 | 秒数 | 备注 |\n|---|---|---|---:|---|\n`;
  if (kind === "blank") return `# ${title}\n\n`;
  const number = /^(\d+)/.exec(title)?.[1].padStart(2, "0") ?? "01";
  return createEpisodeTemplate(title, number, defaultResolution);
}
