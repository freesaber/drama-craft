import type { Nodes, Root, Table, TableCell } from "mdast";
import { visit } from "unist-util-visit";
import { normalizeReference, plain } from "./markdown";
import type { CharacterData, EpisodeData, Shot } from "./types";
import { ui } from "./i18n";
import { ROLE_COLUMNS, ASSET_COLUMNS, DIALOGUE_COLUMNS } from "./episodeFormat";

const ids = (value: string) => [
  ...new Set((value.match(/S\d+/gi) ?? []).map((id) => id.toUpperCase())),
];
const cellText = (cell?: TableCell) => (cell ? plain(cell).trim() : "");
const empty = (value: string) => !value || value === "—" || value === "-";

/** Document adapters return domain objects. Components never need table/heading nodes. */
export function parseEpisode(
  source: string,
  tree: Root,
  shots: Shot[],
): EpisodeData {
  const title = tree.children.find(
    (n) => n.type === "heading" && n.depth === 1,
  );
  const marker = tree.children
    .filter((n) => n.type === "html")
    .map((n) => n.value)
    .join("\n")
    .match(/<!--\s*drama-craft:episode:v(\d+)\s*-->/);
  const data: EpisodeData = {
    format: marker ? (marker[1] === "1" ? "v1" : "unsupported") : "document",
    title: title ? plain(title) : "",
    summary: "",
    characters: [],
    assets: [],
    dialogues: [],
    castByShot: {},
    diagnostics: [],
  };
  if (data.format === "document") return data;
  if (data.format === "unsupported") {
    data.diagnostics.push(ui.episodeData.unsupported);
    return data;
  }
  const preamble = tree.children.filter(
    (n) => n.position!.start.offset! < (shots[0]?.offset ?? source.length),
  );
  const summary = preamble.find(
    (n) => n.type === "paragraph" && /^本[集章]内容[：:]/.test(plain(n)),
  );
  data.summary = summary
    ? plain(summary).replace(/^本[集章]内容[：:]\s*/, "")
    : "";
  const definitions = new Map<string, string>();
  visit(tree, "definition", (n) => {
    if (!definitions.has(n.identifier)) definitions.set(n.identifier, n.url);
  });
  function refs(node?: Nodes) {
    const found = new Set<string>();
    if (node)
      visit(node, (n) => {
        let value: string | undefined;
        if (n.type === "image" || n.type === "link") value = n.url;
        if (n.type === "inlineCode") value = n.value;
        if (n.type === "imageReference" || n.type === "linkReference")
          value = definitions.get(n.identifier);
        const ref = value ? normalizeReference(value) : null;
        if (ref) found.add(ref);
      });
    return [...found];
  }
  const onlyRef = (
    cell: TableCell | undefined,
    context: string,
    kind?: "image" | "audio",
  ) => {
    const values = refs(cell);
    if (values.length > 1)
      data.diagnostics.push(ui.episodeData.multiple(context));
    if (
      values.length === 1 &&
      kind &&
      !(
        kind === "image"
          ? /\.(png|jpe?g|webp|gif|bmp)$/i
          : /\.(mp3|wav|flac|ogg|m4a)$/i
      ).test(values[0])
    ) {
      data.diagnostics.push(ui.episodeData.invalidField(context));
      return null;
    }
    return values.length === 1 ? values[0] : null;
  };
  const tables = preamble.filter((n): n is Table => n.type === "table");
  const columns = (table: Table) => table.children[0].children.map(cellText);
  const exact = (a: string[], b: string[]) => a.join("|") === b.join("|");
  const generationPrompt = (name: string) => {
    const headerIndex = preamble.findIndex(
      (n) => n.type === "heading" && n.depth === 3 && plain(n) === name,
    );
    if (headerIndex < 0) return "";
    for (const node of preamble.slice(headerIndex + 1)) {
      if (node.type === "heading") break;
      if (node.type === "code") return node.value;
    }
    return "";
  };
  const canonicalRoles = ROLE_COLUMNS;
  const canonicalAssets = ASSET_COLUMNS;
  const canonicalDialogue = DIALOGUE_COLUMNS;
  const roleTables = tables.filter((t) => exact(columns(t), canonicalRoles));
  if (roleTables.length > 1)
    data.diagnostics.push(ui.episodeData.duplicateRoles);
  if (data.format === "v1" && roleTables.length !== 1)
    data.diagnostics.push(ui.episodeData.missingRoles);
  if (roleTables.length === 1) {
    for (const row of roleTables[0].children.slice(1)) {
      const c = row.children;
      data.characters.push({
        id: cellText(c[0]),
        name: cellText(c[1]),
        description: "",
        image: onlyRef(c[2], cellText(c[1]), "image"),
        imagePrompt: generationPrompt(cellText(c[1])),
        voice: onlyRef(c[3], cellText(c[1]), "audio"),
        shots: ids(cellText(c[4])),
      });
    }
  }
  const roleIds = new Set<string>(),
    roleNames = new Set<string>();
  for (const role of data.characters) {
    if (
      !/^[CN]\d+$/.test(role.id) ||
      !role.name ||
      roleIds.has(role.id) ||
      roleNames.has(role.name)
    )
      data.diagnostics.push(ui.episodeData.invalidRole(role.id || role.name));
    roleIds.add(role.id);
    roleNames.add(role.name);
  }
  for (const table of tables) {
    const headers = columns(table);
    if (exact(headers, canonicalAssets))
      for (const row of table.children.slice(1)) {
        const c = row.children;
        const name = cellText(c[1]);
        const ref = onlyRef(c[3], name);
        data.assets.push({
          id: cellText(c[0]),
          name,
          kind: cellText(c[2]),
          reference: ref,
          shots: ids(cellText(c[4])),
          note: "",
          prompt: generationPrompt(name),
        });
      }
    if (exact(headers, canonicalDialogue))
      for (const row of table.children.slice(1)) {
        const c = row.children;
        const id = cellText(c[1]);
        const matches = data.characters.filter((r) => r.id === id);
        if (matches.length !== 1) {
          data.diagnostics.push(ui.episodeData.unknownRole(id));
          continue;
        }
        data.dialogues.push({
          shotId: cellText(c[0]).toUpperCase(),
          characterId: matches[0].id,
          delivery: cellText(c[2]),
          text: cellText(c[3]),
          interval: cellText(c[4]),
        });
      }
  }
  const shotIds = new Set(shots.map((s) => s.id));
  for (const role of data.characters)
    for (const id of role.shots)
      if (!shotIds.has(id))
        data.diagnostics.push(ui.episodeData.unknownShot(id));
  for (const line of data.dialogues)
    if (!shotIds.has(line.shotId))
      data.diagnostics.push(ui.episodeData.unknownShot(line.shotId));
  for (const shot of shots) {
    const nodes = tree.children.filter(
      (n) =>
        n.position!.start.offset! >= shot.headingEnd &&
        n.position!.start.offset! < shot.end,
    );
    const assignments = nodes.filter(
      (n) => n.type === "paragraph" && /^角色[：:]/.test(plain(n)),
    );
    const assignment =
      assignments.length === 1
        ? plain(assignments[0]).replace(/^角色[：:]\s*/, "")
        : "";
    if (data.format === "v1" && assignments.length !== 1)
      data.diagnostics.push(ui.episodeData.missingCast(shot.id));
    const cast =
      assignments.length === 1
        ? empty(assignment)
          ? []
          : assignment.split(/[、,，\s]+/).filter(Boolean)
        : [];
    for (const id of cast)
      if (!roleIds.has(id))
        data.diagnostics.push(ui.episodeData.unknownRole(id));
    data.castByShot[shot.id] = cast.filter((id) => roleIds.has(id));
    if (data.format === "v1") {
      for (const role of data.characters)
        if (role.shots.includes(shot.id) !== cast.includes(role.id))
          data.diagnostics.push(ui.episodeData.castMismatch(shot.id, role.id));
      const stories = nodes.filter(
        (n) => n.type === "heading" && n.depth === 3 && plain(n) === "故事走向",
      );
      if (stories.length !== 1)
        data.diagnostics.push(ui.episodeData.missingStory(shot.id));
    }
  }
  data.diagnostics = [...new Set(data.diagnostics)];
  return data;
}
