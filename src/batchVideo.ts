import { applySourcePatch, fieldPatch, parseStoryboard } from "./storyboard";
import type { Snapshot } from "./types";

export interface BatchVideoDocumentStore {
  read(handle: string, path: string): Promise<Snapshot>;
  save(
    handle: string,
    path: string,
    text: string,
    expectedHash: string,
  ): Promise<Snapshot>;
  exists?(
    handle: string,
    document: string,
    reference: string,
  ): Promise<boolean>;
}

export interface BatchVideoApplyResult {
  snapshot: Snapshot;
  changed: boolean;
}

/**
 * Select a downloaded batch result in its own Markdown document.
 *
 * `base` is used only for the currently open, clean document. Background
 * documents are always read immediately before the hash-guarded save.
 */
export async function applyBatchVideoDocument(
  store: BatchVideoDocumentStore,
  handle: string,
  document: string,
  shotId: string,
  reference: string,
  base?: Snapshot,
  replaceExisting = true,
): Promise<BatchVideoApplyResult> {
  const snapshot = base ?? (await store.read(handle, document));
  if (snapshot.readonly)
    throw new Error("当前文档为只读，无法写入批量生成结果");

  const board = parseStoryboard(snapshot.text);
  const cards = board.cards.filter((item) => item.id === shotId);
  if (cards.length !== 1) throw new Error(`无法唯一定位分镜 ${shotId}`);
  const field = cards[0].fields.videoFile;
  if (field.value === reference) return { snapshot, changed: false };
  if (
    !replaceExisting &&
    field.value.trim() &&
    store.exists &&
    (await store.exists(handle, document, field.value))
  )
    return { snapshot, changed: false };

  const text = applySourcePatch(
    snapshot.text,
    fieldPatch(board, field, reference),
  );
  return {
    snapshot: await store.save(handle, document, text, snapshot.hash),
    changed: true,
  };
}
