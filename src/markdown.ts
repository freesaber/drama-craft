import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import type { Root, Node, PhrasingContent } from "mdast";
import type { DocumentEntry, Shot } from "./types";

const parser = unified().use(remarkParse).use(remarkGfm);
const mediaExtension =
  /\.(?:png|jpe?g|webp|gif|bmp|mp3|wav|flac|ogg|m4a|mp4|webm|mov)$/i;
function plain(node: Node): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node)
    return (node.children as PhrasingContent[]).map(plain).join("");
  return "";
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
  const shots: Shot[] = [];
  const references = new Set<string>();
  const diagnostics: string[] = [];
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node) => {
    definitions.set(node.identifier, node.url);
  });
  const addReference = (value: string) => {
    const ref = normalizeReference(value);
    if (ref) references.add(ref);
  };
  visit(tree, (node) => {
    if (node.type === "heading" && node.depth === 2) {
      const heading = plain(node);
      const match = /^(S\d+)\s+(.+)$/i.exec(heading);
      if (match) {
        const id = match[1].toUpperCase();
        if (shots.some((s) => s.id === id))
          diagnostics.push(`镜号 ${id} 重复；请核对标题。`);
        shots.push({
          id,
          title: match[2],
          offset: node.position?.start.offset ?? 0,
          line: node.position?.start.line ?? 1,
        });
      }
    }
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
export function documentTemplate(kind: string, filename: string): string {
  const title = filename.replace(/\.md$/i, "");
  if (kind === "outline")
    return `# ${title}\n\n## 故事背景\n\n## 人物与目标\n\n## 完整故事\n\n## 分集规划\n`;
  if (kind === "table")
    return `# ${title}\n\n| 镜号 | 集 | 镜头名 | 秒数 | 备注 |\n|---|---|---|---:|---|\n`;
  if (kind === "blank") return `# ${title}\n\n`;
  const number = /^(\d+)/.exec(title)?.[1].padStart(2, "0") ?? "01";
  return `# 第${number}集 ${title.replace(/^\d+\s*/, "")}\n\n本集内容：\n\n## 角色库与音色库素材\n\n| 角色 | 素材文件 | 用途 |\n|---|---|---|\n\n## 本集使用素材\n\n| 素材 | 保存文件名 | 使用镜号 |\n|---|---|---|\n\n## S001 镜头名\n\n### 首帧生成\n\n出图文件名：\`${number} 首帧_S001.png\`。\n\n**首帧图片提示词**\n\n\`\`\`text\n在此描述动作开始前的静态画面。\n\`\`\`\n\n### 视频生成\n\n视频文件名：\`${number} S001.mp4\`。\n\n| API参数 | 提示词标签 | 上传素材 |\n|---|---|---|\n| \`ref_image_0\` | \`<Picture 1>\` | \`${number} 首帧_S001.png\` |\n\n**视频提示词｜duration=5，resolution=768p横**\n\n\`\`\`text\n<Picture 1>：本镜完整首帧。\n在此描述动作、摄影机行为与声音。\n\`\`\`\n`;
}
