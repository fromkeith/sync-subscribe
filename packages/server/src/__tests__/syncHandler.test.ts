import { describe, expect, it, beforeEach, vi } from "vitest";
import { EMPTY_SYNC_TOKEN, encodeSyncToken, matchesFilter } from "@sync-subscribe/core";
import type { SyncPatch, SyncRecord, SyncToken, SubscriptionFilter } from "@sync-subscribe/core";
import { SyncHandler } from "../syncHandler.js";
import type { SyncStore } from "../types.js";

interface TestRecord extends SyncRecord {
  name: string;
  ownerId?: string;
}

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    recordId: "r1",
    createdAt: 1000,
    updatedAt: 2000,
    revisionCount: 1,
    name: "hello",
    ...overrides,
  };
}

class InMemoryStore implements SyncStore<TestRecord> {
  records = new Map<string, TestRecord>();
  computePartialSyncToken?: SyncStore<TestRecord>["computePartialSyncToken"];

  async getRecordsSince(
    subscriptions: { filter: SubscriptionFilter; since: SyncToken }[],
  ): Promise<SyncPatch<TestRecord>[]> {
    return [...this.records.values()]
      .filter((r) => subscriptions.some((s) => matchesFilter(r as Record<string, unknown>, s.filter)))
      .map((r) => ({ op: "upsert", record: r }));
  }

  async upsert(record: TestRecord): Promise<TestRecord> {
    this.records.set(record.recordId, record);
    return record;
  }

  async getById(recordId: string): Promise<TestRecord | null> {
    return this.records.get(recordId) ?? null;
  }
}

describe("SyncHandler", () => {
  let store: InMemoryStore;
  let handler: SyncHandler<TestRecord>;

  beforeEach(() => {
    store = new InMemoryStore();
    handler = new SyncHandler(store);
    vi.useRealTimers();
  });

  describe("pull", () => {
    it("returns patches and a new syncToken per key", async () => {
      store.records.set("r1", makeRecord());

      const result = await handler.pull([
        { key: "sub-1", filter: { name: "hello" }, syncToken: EMPTY_SYNC_TOKEN },
      ]);

      expect(result.patches).toHaveLength(1);
      expect(result.patches[0]).toMatchObject({ op: "upsert" });
      expect(result.syncTokens["sub-1"]).not.toBe(EMPTY_SYNC_TOKEN);
    });

    it("returns unchanged syncToken when no records match the filter", async () => {
      store.records.set("r1", makeRecord({ name: "world" }));
      const token = encodeSyncToken({ updatedAt: 500, revisionCount: 1, recordId: "r0" });

      const result = await handler.pull([
        { key: "sub-1", filter: { name: "hello" }, syncToken: token },
      ]);

      expect(result.patches).toHaveLength(0);
      expect(result.syncTokens["sub-1"]).toBe(token);
    });

    it("deduplicates patches across multiple subscriptions", async () => {
      store.records.set("r1", makeRecord());

      const result = await handler.pull([
        { key: "sub-1", filter: { name: "hello" }, syncToken: EMPTY_SYNC_TOKEN },
        { key: "sub-2", filter: { name: "hello" }, syncToken: EMPTY_SYNC_TOKEN },
      ]);

      expect(result.patches).toHaveLength(1);
      expect(result.syncTokens["sub-1"]).toBeDefined();
      expect(result.syncTokens["sub-2"]).toBeDefined();
    });

    it("returns a key in syncTokens for every subscription in the request", async () => {
      const result = await handler.pull([
        { key: "a", filter: {}, syncToken: EMPTY_SYNC_TOKEN },
        { key: "b", filter: {}, syncToken: EMPTY_SYNC_TOKEN },
      ]);

      expect(Object.keys(result.syncTokens)).toEqual(["a", "b"]);
    });
  });

  describe("push", () => {
    it("stores a record with server-stamped updatedAt", async () => {
      const before = Date.now();
      const result = await handler.push({ records: [makeRecord()] });
      const after = Date.now();

      expect(result).toMatchObject({ ok: true });
      expect((result as { serverUpdatedAt: number }).serverUpdatedAt).toBeGreaterThanOrEqual(before);
      expect((result as { serverUpdatedAt: number }).serverUpdatedAt).toBeLessThanOrEqual(after);
      const stored = store.records.get("r1");
      expect(stored).toMatchObject({ recordId: "r1", name: "hello", revisionCount: 1 });
      expect(stored?.updatedAt).toBeGreaterThanOrEqual(before);
      expect(stored?.updatedAt).toBeLessThanOrEqual(after);
    });

    it("stamps createdAt with server time for new records", async () => {
      const before = Date.now();
      await handler.push({ records: [makeRecord({ createdAt: 1 })] });
      const after = Date.now();

      const stored = store.records.get("r1");
      expect(stored?.createdAt).toBeGreaterThanOrEqual(before);
      expect(stored?.createdAt).toBeLessThanOrEqual(after);
    });

    it("preserves createdAt on existing records", async () => {
      store.records.set("r1", makeRecord({ createdAt: 999 }));
      await handler.push({ records: [makeRecord({ revisionCount: 5, createdAt: 1 })] });

      expect(store.records.get("r1")?.createdAt).toBe(999);
    });

    it("returns conflict when server record has higher revisionCount", async () => {
      const serverRecord = makeRecord({ revisionCount: 10 });
      store.records.set("r1", serverRecord);

      const result = await handler.push({ records: [makeRecord({ revisionCount: 1 })] });

      expect(result).toMatchObject({ conflict: true, serverRecord });
    });

    it("enforces readonlyFields", async () => {
      const h = new SyncHandler(store, { readonlyFields: ["ownerId"] });
      store.records.set("r1", makeRecord({ ownerId: "server-owner" }));

      await h.push({ records: [makeRecord({ revisionCount: 5, ownerId: "hacker" })] });

      expect(store.records.get("r1")?.ownerId).toBe("server-owner");
    });

    it("calls onRecordsChanged with stored records", async () => {
      const changed = vi.fn();
      const h = new SyncHandler(store, { onRecordsChanged: changed });

      await h.push({ records: [makeRecord()] });

      expect(changed).toHaveBeenCalledOnce();
      expect(changed.mock.calls[0]![0][0]).toMatchObject({ recordId: "r1" });
    });

    it("does not call onRecordsChanged on conflict", async () => {
      const changed = vi.fn();
      const h = new SyncHandler(store, { onRecordsChanged: changed });
      store.records.set("r1", makeRecord({ revisionCount: 99 }));

      await h.push({ records: [makeRecord({ revisionCount: 1 })] });

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe("serverUpsert", () => {
    it("stores a new record with server-stamped timestamps, preserving caller revisionCount", async () => {
      const before = Date.now();
      const stored = await handler.serverUpsert(makeRecord({ revisionCount: 1 }));
      const after = Date.now();

      expect(stored.revisionCount).toBe(1); // caller owns revisionCount
      expect(stored.updatedAt).toBeGreaterThanOrEqual(before);
      expect(stored.updatedAt).toBeLessThanOrEqual(after);
      expect(stored.createdAt).toBeGreaterThanOrEqual(before);
    });

    it("preserves caller-provided revisionCount on existing records", async () => {
      store.records.set("r1", makeRecord({ revisionCount: 3 }));
      const stored = await handler.serverUpsert(makeRecord({ name: "updated", revisionCount: 4 }));
      expect(stored.revisionCount).toBe(4); // caller increments; server stores as-is
    });

    it("preserves createdAt for existing records", async () => {
      store.records.set("r1", makeRecord({ createdAt: 42 }));
      const stored = await handler.serverUpsert(makeRecord({ name: "updated" }));
      expect(stored.createdAt).toBe(42);
    });

    it("enforces readonlyFields", async () => {
      const h = new SyncHandler(store, { readonlyFields: ["ownerId"] });
      store.records.set("r1", makeRecord({ ownerId: "original" }));

      const stored = await h.serverUpsert(makeRecord({ ownerId: "tampered", revisionCount: 5 }));
      expect(stored.ownerId).toBe("original");
    });

    it("calls onRecordsChanged", async () => {
      const changed = vi.fn();
      const h = new SyncHandler(store, { onRecordsChanged: changed });

      await h.serverUpsert(makeRecord());

      expect(changed).toHaveBeenCalledOnce();
      expect(changed.mock.calls[0]![0][0]).toMatchObject({ recordId: "r1" });
    });
  });
});
