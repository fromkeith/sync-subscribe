import { describe, expect, it, vi, beforeEach } from "vitest";
import { EMPTY_SYNC_TOKEN, encodeSyncToken } from "@sync-subscribe/core";
import type { SyncRecord, SyncToken, SubscriptionFilter } from "@sync-subscribe/core";
import { SyncClient } from "../syncClient.js";
import type { SyncTransport } from "../types.js";

interface TestRecord extends SyncRecord {
  name: string;
}

function makeTransport(): SyncTransport {
  return {
    createSubscription: vi.fn(async (filter: SubscriptionFilter) => ({
      subscriptionId: "sub-1",
      filter,
      syncToken: EMPTY_SYNC_TOKEN,
    })),
    pull: vi.fn(async () => ({ patches: [], syncToken: EMPTY_SYNC_TOKEN })),
    push: vi.fn(async () => ({ ok: true as const })),
  };
}

function rec(overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    recordId: "r1",
    createdAt: 1000,
    updatedAt: 2000,
    revisionCount: 1,
    name: "hello",
    ...overrides,
  };
}

describe("SyncClient", () => {
  let transport: SyncTransport;
  let client: SyncClient<TestRecord>;

  beforeEach(() => {
    transport = makeTransport();
    client = new SyncClient<TestRecord>(transport);
  });

  it("subscribe calls transport and stores the subscription", async () => {
    const sub = await client.subscribe({ filter: { name: "hello" } });
    expect(sub.subscriptionId).toBe("sub-1");
    expect(transport.createSubscription).toHaveBeenCalledWith(
      { name: "hello" },
      undefined
    );
  });

  it("pull calls transport and applies patches to local store", async () => {
    await client.subscribe({ filter: {} });
    const token = encodeSyncToken({ updatedAt: 2000, revisionCount: 1, recordId: "r1" });
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncToken: token,
    });

    await client.pull();
    expect(await client.store.getById("r1")).toMatchObject({ name: "hello" });
  });

  it("pull emits patch listener", async () => {
    await client.subscribe({ filter: {} });
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncToken: EMPTY_SYNC_TOKEN,
    });

    const patches = await new Promise((resolve) => {
      client.onPatches(resolve);
      client.pull();
    });

    expect(patches).toHaveLength(1);
  });

  it("mutate writes locally and pushes to server", async () => {
    await client.subscribe({ filter: {} });
    const result = await client.mutate(rec());
    expect(result).toBe(true);
    expect(transport.push).toHaveBeenCalledWith("sub-1", [rec()]);
    expect(await client.store.getById("r1")).toMatchObject({ name: "hello" });
  });

  it("mutate returns false and applies server record on conflict", async () => {
    await client.subscribe({ filter: {} });
    const serverRecord = rec({ revisionCount: 99, name: "server" });
    vi.mocked(transport.push).mockResolvedValueOnce({
      conflict: true,
      serverRecord,
    });

    const result = await client.mutate(rec({ revisionCount: 1 }));
    expect(result).toBe(false);
    expect((await client.store.getById("r1"))?.name).toBe("server");
  });

  it("reset clears subscriptions and store", async () => {
    await client.subscribe({ filter: {} });
    await client.mutate(rec());
    await client.reset();
    expect(client.getSubscription("sub-1")).toBeUndefined();
    expect(await client.store.getAll()).toHaveLength(0);
  });
});
