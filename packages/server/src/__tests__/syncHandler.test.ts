import { describe, expect, it, beforeEach, vi } from "vitest";
import { EMPTY_SYNC_TOKEN, encodeSyncToken } from "@sync-subscribe/core";
import type { SyncPatch, SyncRecord, SyncToken, SubscriptionFilter } from "@sync-subscribe/core";
import { SubscriptionManager } from "../subscriptionManager.js";
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
    _filter: SubscriptionFilter,
    _since: SyncToken
  ): Promise<SyncPatch<TestRecord>[]> {
    return [...this.records.values()].map((r) => ({ op: "upsert", record: r }));
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
  let manager: SubscriptionManager<TestRecord>;
  let handler: SyncHandler<TestRecord>;

  beforeEach(() => {
    store = new InMemoryStore();
    manager = new SubscriptionManager();
    handler = new SyncHandler(store, manager);
    vi.useRealTimers();
  });

  describe("pull", () => {
    it("returns patches and a new syncToken", async () => {
      const sub = await manager.create({ name: "hello" });
      store.records.set("r1", makeRecord());

      const result = await handler.pull({
        subscriptionId: sub.subscriptionId,
        syncToken: EMPTY_SYNC_TOKEN,
      });

      expect(result.patches).toHaveLength(1);
      expect(result.patches[0]).toMatchObject({ op: "upsert" });
      expect(result.syncToken).not.toBe(EMPTY_SYNC_TOKEN);
    });

    it("throws for unknown subscription", async () => {
      await expect(
        handler.pull({ subscriptionId: "unknown", syncToken: EMPTY_SYNC_TOKEN })
      ).rejects.toThrow("Unknown subscription");
    });
  });

  describe("push", () => {
    it("stores a record with server-stamped updatedAt", async () => {
      const sub = await manager.create({});
      const before = Date.now();

      const result = await handler.push({
        subscriptionId: sub.subscriptionId,
        records: [makeRecord()],
      });

      const after = Date.now();
      expect(result).toEqual({ ok: true });
      const stored = store.records.get("r1");
      expect(stored).toMatchObject({ recordId: "r1", name: "hello", revisionCount: 1 });
      expect(stored?.updatedAt).toBeGreaterThanOrEqual(before);
      expect(stored?.updatedAt).toBeLessThanOrEqual(after);
    });

    it("stamps createdAt with server time for new records", async () => {
      const sub = await manager.create({});
      const before = Date.now();

      await handler.push({
        subscriptionId: sub.subscriptionId,
        records: [makeRecord({ createdAt: 1 })], // client sends old createdAt
      });

      const after = Date.now();
      const stored = store.records.get("r1");
      expect(stored?.createdAt).toBeGreaterThanOrEqual(before);
      expect(stored?.createdAt).toBeLessThanOrEqual(after);
    });

    it("preserves createdAt on existing records (not overridden)", async () => {
      const sub = await manager.create({});
      const original = makeRecord({ createdAt: 999 });
      store.records.set("r1", original);

      await handler.push({
        subscriptionId: sub.subscriptionId,
        records: [makeRecord({ revisionCount: 5, createdAt: 1 })],
      });

      // createdAt should remain the original server value since record already exists
      const stored = store.records.get("r1");
      expect(stored?.createdAt).toBe(999);
    });

    it("returns conflict when server record has higher revisionCount", async () => {
      const sub = await manager.create({});
      const serverRecord = makeRecord({ revisionCount: 10 });
      store.records.set("r1", serverRecord);

      const result = await handler.push({
        subscriptionId: sub.subscriptionId,
        records: [makeRecord({ revisionCount: 1 })],
      });

      expect(result).toMatchObject({ conflict: true, serverRecord });
    });

    it("enforces readonlyFields — client cannot change them on existing records", async () => {
      const h = new SyncHandler(store, manager, { readonlyFields: ["ownerId"] });
      const sub = await manager.create({});

      // Establish original record with ownerId = "server-owner"
      store.records.set("r1", makeRecord({ ownerId: "server-owner" }));

      // Client tries to change ownerId
      await h.push({
        subscriptionId: sub.subscriptionId,
        records: [makeRecord({ revisionCount: 5, ownerId: "hacker" })],
      });

      expect(store.records.get("r1")?.ownerId).toBe("server-owner");
    });

    it("calls onRecordsChanged with stored records", async () => {
      const changed = vi.fn();
      const h = new SyncHandler(store, manager, { onRecordsChanged: changed });
      const sub = await manager.create({});

      await h.push({
        subscriptionId: sub.subscriptionId,
        records: [makeRecord()],
      });

      expect(changed).toHaveBeenCalledOnce();
      expect(changed.mock.calls[0]![0]).toHaveLength(1);
      expect(changed.mock.calls[0]![0][0]).toMatchObject({ recordId: "r1" });
    });

    it("does not call onRecordsChanged on conflict", async () => {
      const changed = vi.fn();
      const h = new SyncHandler(store, manager, { onRecordsChanged: changed });
      const sub = await manager.create({});
      store.records.set("r1", makeRecord({ revisionCount: 99 }));

      await h.push({
        subscriptionId: sub.subscriptionId,
        records: [makeRecord({ revisionCount: 1 })],
      });

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe("updateSubscription", () => {
    it("creates a new subscription when no previousId is given", async () => {
      const result = await handler.updateSubscription({ name: "hello" });
      expect(result.resetRequired).toBe(false);
      expect(result.syncToken).toBe(EMPTY_SYNC_TOKEN);
      expect(result.subscriptionId).toBeTruthy();
    });

    it("updates existing subscription, no reset when filter unchanged", async () => {
      const { subscriptionId } = await handler.updateSubscription({ name: "hello" });
      const result = await handler.updateSubscription({ name: "hello" }, {}, subscriptionId);
      expect(result.resetRequired).toBe(false);
    });

    it("resets to EMPTY_SYNC_TOKEN when filter changes and store has no computePartialSyncToken", async () => {
      const { subscriptionId } = await handler.updateSubscription({ name: "hello" });
      // Advance the token so we can check it gets reset
      manager.updateSyncToken(subscriptionId, makeRecord());

      const result = await handler.updateSubscription({ name: "world" }, {}, subscriptionId);
      expect(result.resetRequired).toBe(true);
      expect(result.syncToken).toBe(EMPTY_SYNC_TOKEN);
    });

    it("uses partial token from store when filter changes and computePartialSyncToken is implemented", async () => {
      const partialToken = encodeSyncToken({ updatedAt: 500, revisionCount: 0, recordId: "" });
      store.computePartialSyncToken = vi.fn().mockResolvedValue(partialToken);

      const { subscriptionId } = await handler.updateSubscription({ name: "hello" });
      manager.updateSyncToken(subscriptionId, makeRecord({ updatedAt: 1000 }));

      const result = await handler.updateSubscription({ name: "world" }, {}, subscriptionId);
      expect(result.resetRequired).toBe(true); // eviction still required
      expect(result.syncToken).toBe(partialToken); // but smarter starting point
      expect(store.computePartialSyncToken).toHaveBeenCalledOnce();
    });

    it("falls back to full reset when computePartialSyncToken returns EMPTY", async () => {
      store.computePartialSyncToken = vi.fn().mockResolvedValue(EMPTY_SYNC_TOKEN);

      const { subscriptionId } = await handler.updateSubscription({ name: "hello" });
      const result = await handler.updateSubscription({ name: "world" }, {}, subscriptionId);
      expect(result.syncToken).toBe(EMPTY_SYNC_TOKEN);
    });
  });

  describe("serverUpsert", () => {
    it("stores a new record with server-stamped timestamps and revisionCount 1", async () => {
      const before = Date.now();
      const stored = await handler.serverUpsert(makeRecord({ revisionCount: 0 }));
      const after = Date.now();

      expect(stored.revisionCount).toBe(1);
      expect(stored.updatedAt).toBeGreaterThanOrEqual(before);
      expect(stored.updatedAt).toBeLessThanOrEqual(after);
      expect(stored.createdAt).toBeGreaterThanOrEqual(before);
    });

    it("increments revisionCount on existing records", async () => {
      store.records.set("r1", makeRecord({ revisionCount: 3 }));
      const stored = await handler.serverUpsert(makeRecord({ name: "updated" }));
      expect(stored.revisionCount).toBe(4);
    });

    it("preserves createdAt for existing records", async () => {
      store.records.set("r1", makeRecord({ createdAt: 42 }));
      const stored = await handler.serverUpsert(makeRecord({ name: "updated" }));
      expect(stored.createdAt).toBe(42);
    });

    it("enforces readonlyFields", async () => {
      const h = new SyncHandler(store, manager, { readonlyFields: ["ownerId"] });
      store.records.set("r1", makeRecord({ ownerId: "original" }));

      const stored = await h.serverUpsert(makeRecord({ ownerId: "tampered", revisionCount: 5 }));
      expect(stored.ownerId).toBe("original");
    });

    it("calls onRecordsChanged", async () => {
      const changed = vi.fn();
      const h = new SyncHandler(store, manager, { onRecordsChanged: changed });

      await h.serverUpsert(makeRecord());

      expect(changed).toHaveBeenCalledOnce();
      expect(changed.mock.calls[0]![0][0]).toMatchObject({ recordId: "r1" });
    });
  });
});
