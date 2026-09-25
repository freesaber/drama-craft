export interface DownloadRetryRecord {
  localFile: string | null;
  error: string | null;
}

export function canRetryGenerationDownload(record: {
  status: string;
  localFile: string | null;
}) {
  return record.status.toLowerCase() === "download_failed" && !record.localFile;
}

export async function retryGenerationDownload<
  Record extends DownloadRetryRecord,
>(
  taskId: string,
  poll: (taskId: string) => Promise<Record>,
): Promise<Record & { localFile: string }> {
  const record = await poll(taskId);
  if (!record.localFile) {
    throw new Error(record.error?.trim() || "视频重新下载后仍未获得本地文件");
  }
  return record as Record & { localFile: string };
}
