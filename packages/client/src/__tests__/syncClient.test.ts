import { describe, expect, it, vi, beforeEach } from "vitest";
import { EMPTY_SYNC_TOKEN, encodeSyncToken } from "@sync-subscribe/core";
import type { SyncRecord, SyncToken, SubscriptionFilter } from "@sync-subscribe/core";
import { SyncClient } from "../syncClient.js";
import type { SyncTransport, SyncSubscriptionRequest } from "../types.js";

interface TestRecord extends SyncRecord {
  name: string;
}

function makeTransport(): SyncTransport {
  return {
    pull: vi.fn(async (subscriptions: SyncSubscriptionRequest[]) => ({
      patches: [],
      syncTokens: Object.fromEntries(subscriptions.map((s) => [s.key, EMPTY_SYNC_TOKEN])),
    })),
    push: vi.fn(async () => ({ ok: true as const, serverUpdatedAt: 1000 })),
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

let transport: SyncTransport;
let client: SyncClient<TestRecord>;

beforeEach(() => {
  transport = makeTransport();
  client = new SyncClient<TestRecord>(transport);
});

describe("SyncClient", () => {

  it("subscribe generates a client UUID and stores the subscription without a server call", async () => {
    const sub = await client.subscribe({ filter: { name: "hello" } });
    expect(sub.subscriptionId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(sub.filter).toMatchObject({ name: "hello" });
    expect(sub.syncToken).toBe(EMPTY_SYNC_TOKEN);
  });

  it("pull calls transport with key+filter+syncToken and applies patches to local store", async () => {
    const sub = await client.subscribe({ filter: {} });
    const token = encodeSyncToken({ updatedAt: 2000, revisionCount: 1, recordId: "r1" });
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { [sub.subscriptionId]: token },
    });

    await client.pull();
    expect(await client.store.getById("r1")).toMatchObject({ name: "hello" });

    const pullArg = vi.mocked(transport.pull).mock.calls[0]![0];
    expect(pullArg[0]).toMatchObject({ key: sub.subscriptionId, filter: {} });
  });

  it("pull emits patch listener", async () => {
    const sub = await client.subscribe({ filter: {} });
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { [sub.subscriptionId]: EMPTY_SYNC_TOKEN },
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
    expect(transport.push).toHaveBeenCalledWith([rec()]);
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
    const sub = await client.subscribe({ filter: {} });
    await client.mutate(rec());
    await client.reset();
    expect(client.getSubscription(sub.subscriptionId)).toBeUndefined();
    expect(await client.store.getAll()).toHaveLength(0);
  });
});

describe("updateSubscription / eviction", () => {
  it("updateSubscription returns a new sub with the updated filter", async () => {
    const sub1 = await client.subscribe({ filter: { color: "blue" } });

    const updated = await client.updateSubscription(sub1.subscriptionId, { color: "red" });

    expect(updated.filter).toMatchObject({ color: "red" });
    expect(updated.subscriptionId).not.toBe(sub1.subscriptionId); // new UUID
  });

  it("evicts records from old filter not covered by remaining subscriptions", async () => {
    const sub1 = await client.subscribe({ filter: { color: "blue" } });

    // Manually advance token so this sub participates as a "coverage" source
    await client.store.setSubscription(sub1.subscriptionId, {
      ...sub1,
      syncToken: encodeSyncToken({ updatedAt: 1, revisionCount: 1, recordId: "x" }),
    });

    await client.store.write({ recordId: "blue-1", name: "blue note", color: "blue", createdAt: 0, updatedAt: 0, revisionCount: 1 } as unknown as TestRecord);

    await client.updateSubscription(sub1.subscriptionId, { color: "red" });

    // blue-1 matched old filter (color=blue) but not new filter (color=red) and no other sub covers it
    expect(await client.store.getById("blue-1")).toBeUndefined();
  });

  it("does not evict records covered by another active subscription", async () => {
    const sub1 = await client.subscribe({ filter: { color: "blue" } });
    const sub2 = await client.subscribe({ filter: { color: "blue" } }); // also covers blue

    // Give both subs non-empty tokens so they count as coverage
    const tok = encodeSyncToken({ updatedAt: 1, revisionCount: 1, recordId: "x" });
    await client.store.setSubscription(sub1.subscriptionId, { ...sub1, syncToken: tok });
    await client.store.setSubscription(sub2.subscriptionId, { ...sub2, syncToken: tok });

    await client.store.write({ recordId: "b1", name: "blue", color: "blue", createdAt: 0, updatedAt: 0, revisionCount: 1 } as unknown as TestRecord);

    // Update sub1 to red — sub2 still covers blue, so b1 should NOT be evicted
    await client.updateSubscription(sub1.subscriptionId, { color: "red" });

    expect(await client.store.getById("b1")).toBeDefined();
  });
});

describe("stream", () => {
  it("throws when transport does not implement stream", async () => {
    await client.subscribe({ filter: {} });
    expect(() => client.stream()).toThrow("Transport does not support streaming");
  });

  it("applies patches from SSE stream and emits listeners", async () => {
    let capturedOnMessage: ((payload: { patches: unknown[]; syncTokens: Record<string, SyncToken> }) => void) | undefined;
    const streamTransport: SyncTransport = {
      ...makeTransport(),
      stream: vi.fn((_subs, onMessage) => {
        capturedOnMessage = onMessage as typeof capturedOnMessage;
        return () => {};
      }),
    };

    const streamClient = new SyncClient<TestRecord>(streamTransport);
    const sub = await streamClient.subscribe({ filter: {} });

    const receivedPatches: unknown[] = [];
    streamClient.onPatches((p) => receivedPatches.push(...p));

    streamClient.stream();

    // Verify stream was called with key+filter+syncToken shape
    const streamArg = vi.mocked(streamTransport.stream!).mock.calls[0]![0];
    expect(streamArg[0]).toMatchObject({ key: sub.subscriptionId, filter: {} });

    // Simulate SSE message arriving
    await capturedOnMessage!({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { [sub.subscriptionId]: EMPTY_SYNC_TOKEN },
    });

    expect(receivedPatches).toHaveLength(1);
    expect(await streamClient.store.getById("r1")).toMatchObject({ name: "hello" });
  });
});
