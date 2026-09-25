import { describe, expect, it, vi } from "vitest";
import {
  canRetryGenerationDownload,
  retryGenerationDownload,
} from "./generationRetry";

describe("generation download retry", () => {
  it("only offers retry for a download failure without a local file", () => {
    expect(
      canRetryGenerationDownload({
        status: "download_failed",
        localFile: null,
      }),
    ).toBe(true);
    expect(
      canRetryGenerationDownload({
        status: "failed",
        localFile: null,
      }),
    ).toBe(false);
    expect(
      canRetryGenerationDownload({
        status: "download_failed",
        localFile: "01 S011_retry.mp4",
      }),
    ).toBe(false);
  });

  it("polls the existing task instead of submitting a new generation", async () => {
    const completed = {
      localFile: "01 S011_retry.mp4",
      error: null,
    };
    const poll = vi.fn().mockResolvedValue(completed);

    await expect(
      retryGenerationDownload("ab9e8d6d-132d-4918-a45f-6d3c1dfbc0bc", poll),
    ).resolves.toBe(completed);
    expect(poll).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledWith("ab9e8d6d-132d-4918-a45f-6d3c1dfbc0bc");
  });

  it("keeps the provider error when the retry still has no local file", async () => {
    const poll = vi.fn().mockResolvedValue({
      localFile: null,
      error: "视频地址已过期",
    });

    await expect(retryGenerationDownload("task-1", poll)).rejects.toThrow(
      "视频地址已过期",
    );
  });
});
