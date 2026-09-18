import { describe, expect, it, vi } from "vitest";
import { applyBatchVideoDocument } from "./batchVideo";
import type { Snapshot } from "./types";

describe("batch video Markdown updates", () => {
  it("reads and patches the batch document even when it is not the open document", async () => {
    const source =
      "## S001 第一镜\n\n### 视频生成\n\n视频文件名：`02 S001.mp4`。\n\n## S002 第二镜\n";
    const saved: Snapshot = { text: "", hash: "next", readonly: false };
    const read = vi.fn(async () => ({
      text: source,
      hash: "original",
      readonly: false,
    }));
    const save = vi.fn(async (_handle, _path, text: string) => ({
      ...saved,
      text,
    }));

    const result = await applyBatchVideoDocument(
      { read, save },
      "project",
      "02 第二集.md",
      "S001",
      "02 S001_20260918-005547.mp4",
    );

    expect(read).toHaveBeenCalledWith("project", "02 第二集.md");
    expect(save).toHaveBeenCalledWith(
      "project",
      "02 第二集.md",
      source.replace("02 S001.mp4", "02 S001_20260918-005547.mp4"),
      "original",
    );
    expect(result.changed).toBe(true);
  });

  it("is idempotent when the downloaded video is already selected", async () => {
    const source =
      "## S001 第一镜\n\n### 视频生成\n\n视频文件名：`02 S001_done.mp4`。\n";
    const read = vi.fn(async () => ({
      text: source,
      hash: "same",
      readonly: false,
    }));
    const save = vi.fn();

    const result = await applyBatchVideoDocument(
      { read, save },
      "project",
      "02 第二集.md",
      "S001",
      "02 S001_done.mp4",
    );

    expect(result.changed).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not let an old completed batch replace a later valid selection", async () => {
    const source =
      "## S001 第一镜\n\n### 视频生成\n\n视频文件名：`02 S001_manual.mp4`。\n";
    const read = vi.fn(async () => ({
      text: source,
      hash: "same",
      readonly: false,
    }));
    const save = vi.fn();
    const exists = vi.fn(async () => true);

    const result = await applyBatchVideoDocument(
      { read, save, exists },
      "project",
      "02 第二集.md",
      "S001",
      "02 S001_old_batch.mp4",
      undefined,
      false,
    );

    expect(exists).toHaveBeenCalledWith(
      "project",
      "02 第二集.md",
      "02 S001_manual.mp4",
    );
    expect(result.changed).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
