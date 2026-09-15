import type { Root, RootContent, Node } from "mdast";
import { visit } from "unist-util-visit";
import { findShots, matchSectionHeading, normalizeReference, parser, plain } from "./markdown";
import type {
  BoardField,
  ShotCard,
  SourceField,
  SourcePatch,
  SourceRange,
  Storyboard,
} from "./types";
import { ui } from "./i18n";
import { parseEpisode } from "./episode";
import { VIDEO_REF_COLUMNS } from "./episodeFormat";

const range = (node: Node): SourceRange => ({
  start: node.position!.start.offset!,
  end: node.position!.end.offset!,
});
const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
const unique = (fields: SourceField[], missing: SourceField): SourceField =>
  fields.length === 1
    ? fields[0]
    : fields.length > 1
      ? { value: "", ambiguous: true }
      : missing;

function referenceField(text: string, node: Node): SourceField | null {
  const r = range(node);
  const raw = text.slice(r.start, r.end);
  if (node.type === "inlineCode") {
    const ticks = /^`+/.exec(raw)![0].length;
    const value = raw.slice(ticks, -ticks);
    // Multiline or padded code spans have normalization rules; leave them untouched.
    if (value.trim() !== value || /[\r\n]/.test(value)) return null;
    return {
      value,
      syntax: "inline",
      range: { start: r.start + ticks, end: r.end - ticks },
    };
  }
  const match =
    node.type === "definition"
      ? /^\[[^\]]+\]:\s*(?:<([^>\r\n]+)>|([^\s]+))/.exec(raw)
      : /\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))/.exec(raw);
  if (!match) return null;
  const value = match[1] ?? match[2];
  // Nested parentheses and Markdown escapes need a richer destination parser.
  // Do not patch a regex prefix that differs from the AST's complete destination.
  if ("url" in node && node.url !== value) return null;
  const start = r.start + match.index + match[0].lastIndexOf(value);
  return {
    value,
    syntax: match[1] !== undefined ? "angle" : "url",
    range: { start, end: start + value.length },
  };
}

export function parseStoryboard(source: string): Storyboard {
  const tree = parser.parse(source) as Root;
  const shots = findShots(source, tree);
  const episode = parseEpisode(source, tree, shots);
  const eol = eolOf(source);
  const definitions = new Map<string, Node[]>();
  visit(tree, "definition", (node) => {
    definitions.set(node.identifier, [
      ...(definitions.get(node.identifier) ?? []),
      node,
    ]);
  });
  const seen = new Set<string>();
  const diagnostics: string[] = [...episode.diagnostics];
  const cards: ShotCard[] = shots.map((shot) => {
    const nodes = tree.children.filter(
      (node) =>
        range(node).start >= shot.headingEnd && range(node).start < shot.end,
    );
    const localDiagnostics: string[] = [];
    if (seen.has(shot.id)) diagnostics.push(ui.board.duplicate(shot.id));
    seen.add(shot.id);
    const level = "#".repeat(Math.max(3, Math.min(6, shot.depth + 1)));
    const missing = (before: string, after = eol + eol): SourceField =>
      shot.depth === 6
        ? { value: "", ambiguous: true }
        : {
            value: "",
            insertion: { offset: shot.end, before: eol + eol + before, after },
          };
    const sectionNodes = (name: string) =>
      nodes.filter(
        (n) => n.type === "heading" && matchSectionHeading(plain(n), name),
      );
    const sections = (name: string): RootContent[][] =>
      sectionNodes(name).map((header) => {
        const index = nodes.indexOf(header);
        const depth = header.type === "heading" ? header.depth : 3;
        const end = nodes.findIndex(
          (n, i) => i > index && n.type === "heading" && n.depth <= depth,
        );
        return nodes.slice(index + 1, end < 0 ? undefined : end);
      });
    const storyHeaders = sectionNodes("故事走向");
    const stories = sections("故事走向").map((contents, i): SourceField => {
      const start = range(storyHeaders[i]).end;
      const index = nodes.indexOf(storyHeaders[i]);
      const depth =
        storyHeaders[i].type === "heading" ? storyHeaders[i].depth : 3;
      const next = nodes
        .slice(index + 1)
        .find((n) => n.type === "heading" && n.depth <= depth);
      const end = next ? range(next).start : shot.end;
      const raw = source.slice(start, end);
      if (
        contents.some(
          (n) =>
            n.type !== "paragraph" ||
            n.children.some((child) => child.type !== "text"),
        )
      )
        return { value: "", ambiguous: true };
      return {
        value: raw.trim(),
        range: { start, end },
        padding: { before: eol + eol, after: eol + eol },
      };
    });
    const prompt = (label: string, section: string): SourceField => {
      const matches: SourceField[] = [];
      let invalid = false;
      // A label must be followed immediately by one fenced code node.
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (
          node.type !== "paragraph" ||
          !new RegExp(`^${label}(?:[｜|\\r\\n]|$)`).test(plain(node))
        )
          continue;
        const code = nodes[i + 1];
        if (!code || code.type !== "code") {
          invalid = true;
          continue;
        }
        const raw = source.slice(range(code).start, range(code).end);
        const opening = /^(`{3,}|~{3,})([^\r\n]*)\r?\n/.exec(raw);
        if (
          !opening ||
          !new RegExp(
            `(?:^|\\n)${opening[1][0]}{${opening[1].length},}[ \\t]*$`,
          ).test(raw)
        ) {
          invalid = true;
          continue;
        }
        matches.push({
          value: code.value,
          range: range(code),
          fence: { marker: opening[1], info: opening[2] },
        });
      }
      if (invalid || sectionNodes(section).length > 1)
        return { value: "", ambiguous: true };
      // Preserve unfamiliar content in an existing section; do not introduce a competing prompt.
      if (!matches.length && sectionNodes(section).length)
        return { value: "", ambiguous: true };
      return unique(matches, {
        ...missing(`${level} ${section}${eol}${eol}**${label}**${eol}${eol}`),
        fence: { marker: "```", info: "text" },
      });
    };
    const labeledFile = (label: string): SourceField => {
      const matches: SourceField[] = [];
      let invalid = false;
      for (const node of nodes) {
        if (node.type !== "paragraph" || !plain(node).startsWith(label))
          continue;
        const r = range(node),
          raw = source.slice(r.start, r.end);
        const match = new RegExp(
          `^${label}[：:]\\s*\x60([^\x60\\r\\n]*)\x60(?=$|[。．.；;\\s])`,
        ).exec(raw);
        const start = match ? r.start + raw.indexOf("`") + 1 : 0;
        const field: SourceField | null = match
          ? {
              value: match[1],
              syntax: "inline",
              range: { start, end: start + match[1].length },
            }
          : null;
        if (field) matches.push(field);
        else invalid = true;
      }
      return invalid
        ? { value: "", ambiguous: true }
        : {
            ...unique(matches, missing(`${label}：\``, `\`。${eol}${eol}`)),
            syntax: "inline",
          };
    };
    const parameter = (name: string): SourceField => {
      const labels = nodes.filter(
        (n) =>
          n.type === "paragraph" && /^视频提示词(?:[｜|\r\n]|$)/.test(plain(n)),
      );
      if (labels.length > 1) return { value: "", ambiguous: true };
      if (!labels.length) return { value: "", ambiguous: true };
      const r = range(labels[0]);
      const raw = source.slice(r.start, r.end);
      if (/[\r\n]/.test(raw)) return { value: "", ambiguous: true };
      const matches = [
        ...raw.matchAll(new RegExp(`\\b${name}=([^，,|｜*\\s]*)`, "g")),
      ];
      if (matches.length > 1) return { value: "", ambiguous: true };
      if (matches.length) {
        const m = matches[0];
        const start = r.start + m.index! + name.length + 1;
        return {
          value: m[1],
          syntax: "parameter",
          range: { start, end: start + m[1].length },
        };
      }
      const end = r.end - (raw.endsWith("**") ? 2 : 0);
      return {
        value: "",
        syntax: "parameter",
        insertion: { offset: end, before: `｜${name}=`, after: "" },
      };
    };
    const headingRaw = source.slice(shot.offset, shot.headingEnd);
    const headingMatch = /^(?:#{1,6}\s+)?S\d+(?:[ \t]+)?/i.exec(headingRaw);
    const titleEnd = headingRaw.replace(/[ \t]+#+[ \t]*$/, "").length;
    const title: SourceField =
      headingMatch && !/[\r\n]/.test(headingRaw)
        ? headingMatch[0].length === titleEnd
          ? {
              value: "",
              insertion: {
                offset: shot.offset + titleEnd,
                before: " ",
                after: "",
              },
            }
          : {
              value: headingRaw.slice(headingMatch[0].length, titleEnd),
              range: {
                start: shot.offset + headingMatch[0].length,
                end: shot.offset + titleEnd,
              },
            }
        : { value: shot.title, ambiguous: true };
    const fields: Record<BoardField, SourceField> = {
      title: { ...title, syntax: "title" },
      story: unique(stories, missing(`${level} 故事走向${eol}${eol}`)),
      framePrompt: prompt("首帧图片提示词", "首帧生成"),
      videoPrompt: prompt("视频提示词", "视频生成"),
      duration: parameter("duration"),
      resolution: parameter("resolution"),
      frameFile: labeledFile("出图文件名"),
      videoFile: labeledFile("视频文件名"),
    };
    const frameAssets: ShotCard["frameAssets"] = [];
    const frameAssetRefs = new Set<string>();
    for (const contents of sections("首帧生成")) {
      for (const node of contents) {
        if (node.type !== "paragraph") continue;
        const nodeRange = range(node);
        const raw = source.slice(nodeRange.start, nodeRange.end);
        const attachment = raw.search(/GPT\s*附件[：:]/i);
        if (attachment < 0) continue;
        visit(node, (child) => {
          if (child.type !== "inlineCode" && child.type !== "link") return;
          const childRange = range(child);
          const localStart = childRange.start - nodeRange.start;
          if (localStart <= attachment) return;
          const reference = normalizeReference(
            child.type === "inlineCode" ? child.value : child.url,
          );
          if (!reference || frameAssetRefs.has(reference)) return;
          const prefix = raw.slice(attachment, localStart);
          const match =
            /图片\s*(\d+)\s*[＝=]\s*([^；;（(\r\n]*)[（(]?\s*$/.exec(prefix);
          if (!match) return;
          frameAssets.push({
            label: `图片${match[1]}`,
            name: match[2].trim() || `图片${match[1]}`,
            reference,
          });
          frameAssetRefs.add(reference);
        });
      }
    }
    const videoInputs: ShotCard["videoInputs"] = [];
    const videoInputKeys = new Set<string>();
    const cellPlain = (cell?: Node) => (cell ? plain(cell).trim() : "");
    const cellReference = (cell?: Node) => {
      if (!cell) return null;
      const found: string[] = [];
      visit(cell, (child) => {
        let value: string | undefined;
        if (child.type === "inlineCode" && "value" in child)
          value = String(child.value);
        else if (
          (child.type === "link" || child.type === "image") &&
          "url" in child
        )
          value = String(child.url);
        const ref = value ? normalizeReference(value) : null;
        if (ref) found.push(ref);
      });
      if (found.length === 1) return found[0];
      return normalizeReference(cellPlain(cell));
    };
    for (const contents of sections("视频生成")) {
      for (const node of contents) {
        if (node.type !== "table" || !node.children.length) continue;
        const headers = node.children[0].children.map((cell) => cellPlain(cell));
        if (headers.join("|") !== VIDEO_REF_COLUMNS.join("|")) continue;
        for (const row of node.children.slice(1)) {
          const cells = row.children;
          const param = cellPlain(cells[0]);
          const tag = cellPlain(cells[1]);
          const reference = cellReference(cells[2]);
          const kind = /^ref_image_\d+$/i.test(param)
            ? "image"
            : /^ref_audio_\d+$/i.test(param)
              ? "audio"
              : null;
          if (!kind || !reference) continue;
          const key = `${kind}:${param}:${reference}`;
          if (videoInputKeys.has(key)) continue;
          videoInputKeys.add(key);
          videoInputs.push({ param, tag, reference, kind });
        }
      }
    }
    videoInputs.sort((a, b) => {
      const rank = (item: ShotCard["videoInputs"][number]) => {
        const match = /(\d+)$/.exec(item.param);
        return (item.kind === "audio" ? 1000 : 0) + Number(match?.[1] ?? 0);
      };
      return rank(a) - rank(b);
    });
    if (Object.values(fields).some((f) => f.ambiguous))
      localDiagnostics.push(ui.board.unmapped);
    const references: ShotCard["references"] = [];
    const refsSeen = new Set<string>();
    for (const node of nodes)
      visit(node, (child) => {
        let target: Node = child;
        let value: string | undefined;
        let ambiguous = false;
        if (child.type === "image" || child.type === "link") value = child.url;
        if (child.type === "inlineCode") value = child.value;
        if (child.type === "imageReference" || child.type === "linkReference") {
          const defs = definitions.get(child.identifier) ?? [];
          if (defs.length) {
            target = defs[0];
            value = "url" in target ? String(target.url) : undefined;
            ambiguous = defs.length > 1;
          }
        }
        const ref = value ? normalizeReference(value) : null;
        if (!ref) return;
        const field = referenceField(source, target) ?? {
          value: value!,
          ambiguous: true,
        };
        if (ambiguous) field.ambiguous = true;
        const key = `${field.range?.start}-${ref}`;
        if (!refsSeen.has(key)) references.push({ reference: ref, field });
        refsSeen.add(key);
      });
    return {
      ...shot,
      fields,
      frameAssets,
      videoInputs,
      references,
      diagnostics: localDiagnostics,
    };
  });
  const sections: Storyboard["sections"] = [];
  let cursor = 0;
  cards.forEach((card, index) => {
    if (card.offset > cursor)
      sections.push({
        kind: "document",
        range: { start: cursor, end: card.offset },
      });
    sections.push({ kind: "shot", index });
    cursor = card.end;
  });
  if (cursor < source.length)
    sections.push({
      kind: "document",
      range: { start: cursor, end: source.length },
    });
  return { source, cards, sections, diagnostics, episode };
}

export function fieldPatch(
  board: Storyboard,
  field: SourceField,
  value: string,
): SourcePatch {
  if (field.ambiguous) throw new Error(ui.board.unmapped);
  if (field.syntax && /[\r\n]/.test(value))
    throw new Error(ui.board.invalidReference);
  if (
    (field.syntax === "inline" && /`/.test(value)) ||
    (field.syntax === "angle" && /[<>]/.test(value)) ||
    (field.syntax === "parameter" && /[，,|｜*\s]/.test(value))
  )
    throw new Error(ui.board.invalidReference);
  const eol = eolOf(board.source);
  let replacement = value.replace(/\r?\n/g, eol);
  if (field.syntax === "url")
    replacement = value.replace(/[\s<>()[\]"\\]/g, (char) =>
      encodeURIComponent(char),
    );
  if (field.fence) {
    const char = field.fence.marker[0];
    const longest = Math.max(
      0,
      ...[...value.matchAll(new RegExp(`${char}+`, "g"))].map(
        (m) => m[0].length,
      ),
    );
    const fence = char.repeat(Math.max(field.fence.marker.length, longest + 1));
    replacement = `${fence}${field.fence.info}${eol}${replacement}${eol}${fence}`;
  }
  if (field.padding)
    replacement = field.padding.before + replacement + field.padding.after;
  if (field.range)
    return { source: board.source, range: field.range, replacement };
  if (!field.insertion) throw new Error(ui.board.unmapped);
  return {
    source: board.source,
    range: { start: field.insertion.offset, end: field.insertion.offset },
    replacement: value
      ? field.insertion.before + replacement + field.insertion.after
      : "",
  };
}

export function applySourcePatch(current: string, patch: SourcePatch): string {
  if (
    current !== patch.source ||
    patch.range.start < 0 ||
    patch.range.end < patch.range.start ||
    patch.range.end > current.length
  )
    throw new Error(ui.board.stale);
  return (
    current.slice(0, patch.range.start) +
    patch.replacement +
    current.slice(patch.range.end)
  );
}
