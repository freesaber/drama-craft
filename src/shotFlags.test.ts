import { describe, expect, it } from "vitest";
import { defaultMergeSelectedIds } from "./shotFlags";

describe("shotFlags", () => {
  it("skips discarded shots in the default merge selection", () => {
    expect(
      defaultMergeSelectedIds(
        [
          { shotId: "S001", exists: true },
          { shotId: "S002", exists: true },
          { shotId: "S003", exists: false },
        ],
        ["S002"],
      ),
    ).toEqual(["S001"]);
  });
});
