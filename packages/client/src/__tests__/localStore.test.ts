import { describe, expect, it } from "vitest";
import { LocalStore } from "../localStore.js";
import type { SyncRecord } from "@sync-subscribe/core";

interface TestRecord extends SyncRecord {
  value: string;
}

function rec(overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    recordId: "r1",
    createdAt: 1000,
    updatedAt: 2000,
    revisionCount: 1,
    value: "a",
    ...overrides,
  };
}

describe("LocalStore", () => {
  it("applies upsert patches", async () => {
    const store = new LocalStore<TestRecord>();
    await store.applyPatches([{ op: "upsert", record: rec() }]);
    expect(await store.getById("r1")).toMatchObject({ value: "a" });
  });

  it("applies delete patches", async () => {
    const store = new LocalStore<TestRecord>();
    await store.write(rec());
    await store.applyPatches([{ op: "delete", recordId: "r1" }]);
    expect(await store.getById("r1")).toBeUndefined();
  });

  it("keeps local record when it has higher revisionCount", async () => {
    const store = new LocalStore<TestRecord>();
    await store.write(rec({ revisionCount: 10, value: "local" }));
    await store.applyPatches([{ op: "upsert", record: rec({ revisionCount: 1, value: "server" }) }]);
    expect((await store.getById("r1"))?.value).toBe("local");
  });

  it("overwrites local record when server has higher revisionCount", async () => {
    const store = new LocalStore<TestRecord>();
    await store.write(rec({ revisionCount: 1, value: "local" }));
    await store.applyPatches([{ op: "upsert", record: rec({ revisionCount: 5, value: "server" }) }]);
    expect((await store.getById("r1"))?.value).toBe("server");
  });

  it("clear removes all records", async () => {
    const store = new LocalStore<TestRecord>();
    await store.write(rec());
    await store.clear();
    expect(await store.getAll()).toHaveLength(0);
  });
});
