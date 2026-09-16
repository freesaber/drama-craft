/** Bust WebView cache after a same-path file replace. */
export function withMediaRevision(
  src: string,
  revision?: string | number | null,
) {
  if (!src || revision == null || revision === "") return src;
  const sep = src.includes("?") ? "&" : "?";
  return `${src}${sep}v=${encodeURIComponent(String(revision))}`;
}
