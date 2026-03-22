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
      resetRequired: false,
    })),
    pull: vi.fn(async (subscriptions: { id: string; syncToken: SyncToken }[]) => ({
      patches: [],
      syncTokens: Object.fromEntries(subscriptions.map((s) => [s.id, EMPTY_SYNC_TOKEN])),
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

  it("subscribe calls transport and stores the subscription", async () => {
    const sub = await client.subscribe({ filter: { name: "hello" } });
    expect(sub.subscriptionId).toBe("sub-1");
    expect(transport.createSubscription).toHaveBeenCalledWith(
      { name: "hello" },
      undefined,
    );
  });

  it("pull calls transport with all subscriptions and applies patches to local store", async () => {
    await client.subscribe({ filter: {} });
    const token = encodeSyncToken({ updatedAt: 2000, revisionCount: 1, recordId: "r1" });
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { "sub-1": token },
    });

    await client.pull();
    expect(await client.store.getById("r1")).toMatchObject({ name: "hello" });
  });

  it("pull emits patch listener", async () => {
    await client.subscribe({ filter: {} });
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { "sub-1": EMPTY_SYNC_TOKEN },
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
    await client.subscribe({ filter: {} });
    await client.mutate(rec());
    await client.reset();
    expect(client.getSubscription("sub-1")).toBeUndefined();
    expect(await client.store.getAll()).toHaveLength(0);
  });
});

describe("updateSubscription / resetRequired eviction", () => {
  it("evicts records from old filter when resetRequired is true", async () => {
    // First subscription: color=blue
    vi.mocked(transport.createSubscription).mockResolvedValueOnce({
      subscriptionId: "sub-1",
      filter: { color: "blue" },
      syncToken: EMPTY_SYNC_TOKEN,
      resetRequired: false,
    });
    await client.subscribe({ filter: { color: "blue" } });

    // Populate store with a blue record
    await client.store.write(rec({ recordId: "blue-1", name: "blue note" }));

    // Update subscription — server returns same ID (it's an update, not a new sub)
    vi.mocked(transport.createSubscription).mockResolvedValueOnce({
      subscriptionId: "sub-1",
      filter: { color: "red" },
      syncToken: EMPTY_SYNC_TOKEN,
      resetRequired: true,
    });
    await client.updateSubscription("sub-1", { color: "red" });

    // sub-1 is updated in place with the new filter
    expect(client.getSubscription("sub-1")).toBeDefined();
    expect(client.getSubscription("sub-1")?.filter).toMatchObject({ color: "red" });
  });

  it("does not evict records covered by another active subscription", async () => {
    vi.mocked(transport.createSubscription)
      .mockResolvedValueOnce({ subscriptionId: "sub-1", filter: { color: "blue" }, syncToken: EMPTY_SYNC_TOKEN, resetRequired: false })
      .mockResolvedValueOnce({ subscriptionId: "sub-2", filter: { color: "green" }, syncToken: EMPTY_SYNC_TOKEN, resetRequired: false })
      .mockResolvedValueOnce({ subscriptionId: "sub-3", filter: { color: "red" }, syncToken: EMPTY_SYNC_TOKEN, resetRequired: true });

    await client.subscribe({ filter: { color: "blue" } });
    await client.subscribe({ filter: { color: "green" } });

    await client.store.write({ recordId: "b1", name: "blue", color: "blue", createdAt: 0, updatedAt: 0, revisionCount: 1 } as unknown as TestRecord);

    await client.updateSubscription("sub-1", { color: "red" });

    // b1 has color=blue, matches evictFilter but also would have been retained if covered by sub-2
    // sub-2 is { color: "green" } which does NOT cover color=blue, so b1 should be evicted
    expect(await client.store.getById("b1")).toBeUndefined();
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
    vi.mocked(streamTransport.createSubscription).mockResolvedValue({
      subscriptionId: "sub-1",
      filter: {},
      syncToken: EMPTY_SYNC_TOKEN,
      resetRequired: false,
    });

    const streamClient = new SyncClient<TestRecord>(streamTransport);
    await streamClient.subscribe({ filter: {} });

    const receivedPatches: unknown[] = [];
    streamClient.onPatches((p) => receivedPatches.push(...p));

    streamClient.stream();

    // Simulate SSE message arriving
    await capturedOnMessage!({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { "sub-1": EMPTY_SYNC_TOKEN },
    });

    expect(receivedPatches).toHaveLength(1);
    expect(await streamClient.store.getById("r1")).toMatchObject({ name: "hello" });
  });
});
