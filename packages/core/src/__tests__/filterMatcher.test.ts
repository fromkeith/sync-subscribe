import { describe, expect, it } from "vitest";
import { matchesFilter, filterDiff } from "../filterMatcher.js";

describe("matchesFilter", () => {
  it("equality match", () => {
    expect(matchesFilter({ color: "blue" }, { color: "blue" })).toBe(true);
    expect(matchesFilter({ color: "red" }, { color: "blue" })).toBe(false);
  });

  it("boolean equality", () => {
    expect(matchesFilter({ isDeleted: false }, { isDeleted: false })).toBe(
      true,
    );
    expect(matchesFilter({ isDeleted: true }, { isDeleted: false })).toBe(
      false,
    );
  });

  it("$gte operator", () => {
    const now = Date.now();
    expect(
      matchesFilter({ createdAt: now }, { createdAt: { $gte: now - 1000 } }),
    ).toBe(true);
    expect(
      matchesFilter(
        { createdAt: now - 2000 },
        { createdAt: { $gte: now - 1000 } },
      ),
    ).toBe(false);
  });

  it("$gt operator", () => {
    expect(matchesFilter({ n: 5 }, { n: { $gt: 4 } })).toBe(true);
    expect(matchesFilter({ n: 4 }, { n: { $gt: 4 } })).toBe(false);
  });

  it("$lte operator", () => {
    expect(matchesFilter({ n: 3 }, { n: { $lte: 3 } })).toBe(true);
    expect(matchesFilter({ n: 4 }, { n: { $lte: 3 } })).toBe(false);
  });

  it("$lt operator", () => {
    expect(matchesFilter({ n: 2 }, { n: { $lt: 3 } })).toBe(true);
    expect(matchesFilter({ n: 3 }, { n: { $lt: 3 } })).toBe(false);
  });

  it("$ne operator", () => {
    expect(matchesFilter({ color: "red" }, { color: { $ne: "blue" } })).toBe(
      true,
    );
    expect(matchesFilter({ color: "blue" }, { color: { $ne: "blue" } })).toBe(
      false,
    );
  });

  it("multiple conditions — all must match", () => {
    const record = { color: "blue", userId: "u1", createdAt: 5000 };
    expect(matchesFilter(record, { color: "blue", userId: "u1" })).toBe(true);
    expect(matchesFilter(record, { color: "blue", userId: "u2" })).toBe(false);
  });

  it("null value with ordering operator returns false", () => {
    expect(matchesFilter({ n: null }, { n: { $gt: 0 } })).toBe(false);
  });

  it("empty filter matches everything", () => {
    expect(matchesFilter({ anything: "yes" }, {})).toBe(true);
  });
});

describe("filterDiff", () => {
  it("identical filters are unchanged", () => {
    const f = { color: "blue", userId: "u1" };
    expect(filterDiff(f, f).unchanged).toBe(true);
  });

  it("detects added conditions", () => {
    const diff = filterDiff({ color: "blue" }, { color: "blue", userId: "u1" });
    expect(diff.added).toEqual({ userId: "u1" });
    expect(diff.removed).toEqual({});
    expect(diff.changed).toEqual({});
    expect(diff.unchanged).toBe(false);
  });

  it("detects removed conditions", () => {
    const diff = filterDiff({ color: "blue", userId: "u1" }, { color: "blue" });
    expect(diff.removed).toEqual({ userId: "u1" });
    expect(diff.added).toEqual({});
    expect(diff.unchanged).toBe(false);
  });

  it("detects changed conditions (primitive)", () => {
    const diff = filterDiff({ color: "blue" }, { color: "red" });
    expect(diff.changed).toEqual({ color: { from: "blue", to: "red" } });
    expect(diff.added).toEqual({});
    expect(diff.removed).toEqual({});
    expect(diff.unchanged).toBe(false);
  });

  it("detects changed conditions (operator)", () => {
    const diff = filterDiff(
      { createdAt: { $gte: 1000 } },
      { createdAt: { $gte: 2000 } },
    );
    expect(diff.changed).toEqual({
      createdAt: { from: { $gte: 1000 }, to: { $gte: 2000 } },
    });
    expect(diff.unchanged).toBe(false);
  });

  it("handles mix of added, removed, and changed", () => {
    const diff = filterDiff(
      { color: "blue", category: "work", userId: "u1" },
      { color: "red",  category: "work", isDeleted: false },
    );
    expect(diff.changed).toEqual({ color: { from: "blue", to: "red" } });
    expect(diff.added).toEqual({ isDeleted: false });
    expect(diff.removed).toEqual({ userId: "u1" });
    expect(diff.unchanged).toBe(false);
  });

  it("both empty filters are unchanged", () => {
    expect(filterDiff({}, {}).unchanged).toBe(true);
  });
});
