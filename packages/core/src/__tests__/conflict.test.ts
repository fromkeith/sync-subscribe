import { describe, expect, it } from "vitest";
import { resolveConflict } from "../conflict.js";
import type { SyncRecord } from "../types.js";

const base: SyncRecord = {
  recordId: "r1",
  createdAt: 1000,
  updatedAt: 2000,
  revisionCount: 1,
};

describe("resolveConflict", () => {
  it("higher revisionCount wins", () => {
    const a = { ...base, revisionCount: 5 };
    const b = { ...base, revisionCount: 3 };
    expect(resolveConflict(a, b)).toBe("a");
    expect(resolveConflict(b, a)).toBe("b");
  });

  it("on tie, older updatedAt wins", () => {
    const a = { ...base, revisionCount: 3, updatedAt: 1000 };
    const b = { ...base, revisionCount: 3, updatedAt: 2000 };
    expect(resolveConflict(a, b)).toBe("a"); // a is older → wins
    expect(resolveConflict(b, a)).toBe("b"); // b is newer → loses
  });

  it("equal records: a wins (stable)", () => {
    expect(resolveConflict(base, base)).toBe("a");
  });
});
