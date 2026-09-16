import { describe, expect, it } from "vitest";
import { withMediaRevision } from "./mediaUrl";

describe("withMediaRevision", () => {
  it("appends a cache-busting query without changing the file path", () => {
    expect(withMediaRevision("asset://localhost/01%20首帧_S007.png", "9-12")).toBe(
      "asset://localhost/01%20首帧_S007.png?v=9-12",
    );
    expect(withMediaRevision("https://asset.localhost/a.png?x=1", 3)).toBe(
      "https://asset.localhost/a.png?x=1&v=3",
    );
    expect(withMediaRevision("asset://localhost/a.png", "")).toBe(
      "asset://localhost/a.png",
    );
  });
});
