import { describe, expect, it } from "vitest";
import { PRIVATE_PATH_PATTERN, shouldReplaceMissingSpace } from "../public/private-space.js";

describe("private-space startup recovery", () => {
  const missingPath = `/p/${"a".repeat(43)}`;

  it("replaces a remembered private space when the server no longer recognizes it", () => {
    expect(PRIVATE_PATH_PATTERN.test(missingPath)).toBe(true);
    expect(shouldReplaceMissingSpace(401, missingPath, missingPath)).toBe(true);
  });

  it("does not replace direct links or hide transient server failures", () => {
    expect(shouldReplaceMissingSpace(401, missingPath, null)).toBe(false);
    expect(shouldReplaceMissingSpace(500, missingPath, missingPath)).toBe(false);
  });
});
