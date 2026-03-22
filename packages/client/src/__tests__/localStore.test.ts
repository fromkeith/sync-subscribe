import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../inMemoryStore.js";
import { EMPTY_SYNC_TOKEN, type SyncRecord } from "@sync-subscribe/core";

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

describe("InMemoryStore", () => {
  it("applies upsert patches", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.applyPatches([{ op: "upsert", record: rec() }]);
    expect(await store.getById("r1")).toMatchObject({ value: "a" });
  });

  it("applies delete patches", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.write(rec());
    await store.applyPatches([{ op: "delete", recordId: "r1" }]);
    expect(await store.getById("r1")).toBeUndefined();
  });

  it("keeps local record when it has higher revisionCount", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.write(rec({ revisionCount: 10, value: "local" }));
    await store.applyPatches([
      { op: "upsert", record: rec({ revisionCount: 1, value: "server" }) },
    ]);
    expect((await store.getById("r1"))?.value).toBe("local");
  });

  it("overwrites local record when server has higher revisionCount", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.write(rec({ revisionCount: 1, value: "local" }));
    await store.applyPatches([
      { op: "upsert", record: rec({ revisionCount: 5, value: "server" }) },
    ]);
    expect((await store.getById("r1"))?.value).toBe("server");
  });

  it("clear removes all records", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.write(rec());
    await store.clear();
    expect(await store.getAll()).toHaveLength(0);
  });
});

describe("evict", () => {
  it("removes records matching the evict filter when no subscription covers them", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.write(rec({ recordId: "r1", value: "blue" }));
    await store.write(rec({ recordId: "r2", value: "red" }));

    await store.evict({ value: "blue" });

    expect(await store.getById("r1")).toBeUndefined();
    expect(await store.getById("r2")).toMatchObject({ value: "red" });
  });

  it("removes records matching the filter regardless of subscriptions", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.write(rec({ recordId: "r1", value: "blue" }));

    // evict is unconditional — caller is responsible for computing the safe gap filter
    await store.setSubscription("some-sub", {
      subscriptionId: "some-sub",
      filter: { value: "blue" },
      syncToken: EMPTY_SYNC_TOKEN,
    });

    await store.evict({ value: "blue" });

    expect(await store.getById("r1")).toBeUndefined();
  });

  it("keeps records that do not match the evict filter", async () => {
    const store = new InMemoryStore<TestRecord>();
    await store.write(rec({ recordId: "r1", value: "red" }));

    await store.evict({ value: "blue" });

    expect(await store.getById("r1")).toBeDefined();
  });
});
