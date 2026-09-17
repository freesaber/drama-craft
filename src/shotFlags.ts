export function defaultMergeSelectedIds(
  rows: readonly { shotId: string; exists: boolean }[],
  discardedShotIds: readonly string[],
): string[] {
  const discarded = new Set(discardedShotIds);
  return rows
    .filter((row) => row.exists && !discarded.has(row.shotId))
    .map((row) => row.shotId);
}
