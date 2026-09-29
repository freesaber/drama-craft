import { parseStoryboard } from "./storyboard";

export type AssetType = "character" | "scene" | "prop" | "crowd" | "variant";

export interface AssetEntry {
  id: string;
  type: AssetType;
  name: string;
  aliases: string[];
  keywords: string[];
  firstDocument: string;
  baseId?: string;
}

export interface AssetIndexResult {
  assets: AssetEntry[];
  diagnostics: string[];
  missing: boolean;
}

const types = new Set<AssetType>([
  "character",
  "scene",
  "prop",
  "crowd",
  "variant",
]);
const textArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && Boolean(item.trim()));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseAssetIndex(
  raw: string | null,
  documents: string[],
): AssetIndexResult {
  if (raw === null) return { assets: [], diagnostics: [], missing: true };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      assets: [],
      diagnostics: ["assets.json 不是有效 JSON。"],
      missing: false,
    };
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.assets)
  )
    return {
      assets: [],
      diagnostics: ["assets.json 须包含 schemaVersion: 1 和 assets 数组。"],
      missing: false,
    };
  const assets: AssetEntry[] = [];
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  const knownDocuments = new Set(
    documents.map((path) => path.replaceAll("\\", "/")),
  );
  for (const [position, candidate] of value.assets.entries()) {
    const label = `第 ${position + 1} 条资产`;
    if (!record(candidate)) {
      diagnostics.push(`${label}不是对象。`);
      continue;
    }
    const { id, type, name, aliases, keywords, firstDocument, baseId } =
      candidate;
    if (typeof id !== "string" || !/^(?:C|N|A)(?!0000)\d{4}$/.test(id)) {
      diagnostics.push(`${label}的 ID 须为四位编号（C0001、N0001 或 A0001）。`);
      continue;
    }
    if (ids.has(id)) {
      diagnostics.push(`资产 ID 重复：${id}。`);
      continue;
    }
    ids.add(id);
    if (
      typeof type !== "string" ||
      !types.has(type as AssetType) ||
      (id.startsWith("C") || id.startsWith("N")) !== (type === "character")
    ) {
      diagnostics.push(`${id} 的类型与编号不匹配。`);
      continue;
    }
    if (
      typeof name !== "string" ||
      !name.trim() ||
      !textArray(aliases) ||
      !textArray(keywords)
    ) {
      diagnostics.push(`${id} 缺少名称、别名数组或关键词数组。`);
      continue;
    }
    if (
      typeof firstDocument !== "string" ||
      !firstDocument.endsWith(".md") ||
      !firstDocument.trim() ||
      firstDocument.includes("\\") ||
      firstDocument.startsWith("/") ||
      firstDocument.includes(":") ||
      firstDocument
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    ) {
      diagnostics.push(
        `${id} 的 firstDocument 必须是项目内相对 Markdown 路径。`,
      );
      continue;
    }
    if (!knownDocuments.has(firstDocument))
      diagnostics.push(`${id} 的首现集不存在：${firstDocument}。`);
    if (type === "variant" && (typeof baseId !== "string" || !baseId))
      diagnostics.push(`${id} 是状态变体，须填写 baseId。`);
    assets.push({
      id,
      type: type as AssetType,
      name: name.trim(),
      aliases,
      keywords,
      firstDocument,
      ...(typeof baseId === "string" ? { baseId } : {}),
    });
  }
  const validIds = new Set(assets.map((asset) => asset.id));
  for (const asset of assets)
    if (
      asset.baseId &&
      (!validIds.has(asset.baseId) || asset.baseId === asset.id)
    )
      diagnostics.push(`${asset.id} 的 baseId 未指向另一条已登记资产。`);
  return { assets, diagnostics, missing: false };
}

export function searchAssets(
  assets: AssetEntry[],
  query: string,
  type = "",
): AssetEntry[] {
  const term = query.trim().toLocaleLowerCase();
  return assets.filter(
    (asset) =>
      (!type || asset.type === type) &&
      (!term ||
        [asset.id, asset.name, ...asset.aliases, ...asset.keywords].some(
          (value) => value.toLocaleLowerCase().includes(term),
        )),
  );
}

export function checkAssetSource(asset: AssetEntry, source: string): string[] {
  const episode = parseStoryboard(source).episode;
  if (episode.format !== "v1")
    return [`${asset.firstDocument} 不是 v1 剧集文档。`];
  if (asset.type === "character") {
    const rows = episode.characters.filter((item) => item.id === asset.id);
    if (rows.length !== 1)
      return [`${asset.firstDocument} 中找不到唯一的 ${asset.id} 表格行。`];
    return rows[0].name === asset.name
      ? []
      : [`${asset.id} 的名称与首现集不一致：${rows[0].name}。`];
  }
  const rows = episode.assets.filter((item) => item.id === asset.id);
  if (rows.length !== 1)
    return [`${asset.firstDocument} 中找不到唯一的 ${asset.id} 表格行。`];
  const row = rows[0];
  const errors: string[] = [];
  if (row.name !== asset.name)
    errors.push(`${asset.id} 的名称与首现集不一致：${row.name}。`);
  const expected: Record<Exclude<AssetType, "character">, string> = {
    scene: "场景",
    prop: "道具",
    crowd: "群像",
    variant: "状态变体",
  };
  if (row.kind !== expected[asset.type])
    errors.push(`${asset.id} 的类型与首现集不一致：${row.kind}。`);
  return errors;
}

/** Resolve a storyboard row through the index without trusting a name-only match. */
export function indexedGenerationPrompt(
  assets: AssetEntry[],
  id: string,
  name: string,
  reference: string | null,
  source: string,
): { prompt: string; firstDocument: string } | null {
  const matches = assets.filter(
    (asset) => asset.id === id && asset.name === name,
  );
  if (matches.length !== 1) return null;
  const asset = matches[0];
  if (checkAssetSource(asset, source).length) return null;
  const episode = parseStoryboard(source).episode;
  const rows =
    asset.type === "character"
      ? episode.characters
          .filter((row) => row.id === id)
          .map((row) => ({ reference: row.image, prompt: row.imagePrompt }))
      : episode.assets
          .filter((row) => row.id === id)
          .map((row) => ({ reference: row.reference, prompt: row.prompt }));
  if (rows.length !== 1 || (reference && rows[0].reference !== reference))
    return null;
  return { prompt: rows[0].prompt, firstDocument: asset.firstDocument };
}
