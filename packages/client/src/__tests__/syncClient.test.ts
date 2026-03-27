import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
    const before = Date.now();
    const result = await client.mutate(rec());
    const after = Date.now();
    expect(result).toBe(true);
    // mutate() stamps updatedAt and increments revisionCount — verify the pushed record
    const pushed = vi.mocked(transport.push).mock.calls[0]![0]![0]!;
    expect(pushed.recordId).toBe("r1");
    expect(pushed.revisionCount).toBe(1); // no existing store record → (0)+1 = 1
    expect(pushed.updatedAt).toBeGreaterThanOrEqual(before);
    expect(pushed.updatedAt).toBeLessThanOrEqual(after);
    expect(await client.store.getById("r1")).toMatchObject({ name: "hello" });
  });

  it("mutate increments revisionCount from existing store record", async () => {
    await client.subscribe({ filter: {} });
    // First mutate — no existing record, revisionCount becomes 1
    await client.mutate(rec({ revisionCount: 0 }));
    // Second mutate — existing has revisionCount 1, so stamped value is 2
    await client.mutate(rec());
    const pushed = vi.mocked(transport.push).mock.calls[1]![0]![0]!;
    expect(pushed.revisionCount).toBe(2);
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

// Drains the microtask queue fully (handles multi-step async chains).
const flushPromises = () => new Promise<void>((r) => setTimeout(r, 0));

describe("query", () => {
  it("emits loading:true then the current store contents", async () => {
    await client.store.write(rec());

    const states: { data: TestRecord[]; loading: boolean }[] = [];
    const unsub = client.query({ filter: {} }).subscribe((s) => states.push(s));

    // loading:true emitted synchronously
    expect(states[0]).toEqual({ data: [], loading: true });

    await flushPromises();
    expect(states.at(-1)).toMatchObject({ loading: false });
    expect(states.at(-1)!.data).toHaveLength(1);

    unsub();
  });

  it("re-emits when the store changes via pull", async () => {
    // pull() requires at least one subscription to send a request
    const sub = await client.subscribe({ filter: {} });

    const states: { data: TestRecord[]; loading: boolean }[] = [];
    const unsub = client.query({ filter: {} }).subscribe((s) => states.push(s));
    await flushPromises(); // initial read

    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { [sub.subscriptionId]: EMPTY_SYNC_TOKEN },
    });
    await client.pull();
    await flushPromises(); // onPatches callback is async

    const last = states.at(-1)!;
    expect(last.loading).toBe(false);
    expect(last.data).toHaveLength(1);

    unsub();
  });

  it("applies the filter — only returns matching records", async () => {
    await client.store.write(rec({ recordId: "r1", name: "hello" }));
    await client.store.write(rec({ recordId: "r2", name: "world" }));

    const states: { data: TestRecord[]; loading: boolean }[] = [];
    const unsub = client.query({ filter: { name: "hello" } }).subscribe((s) => states.push(s));
    await flushPromises();

    const data = states.at(-1)!.data;
    expect(data).toHaveLength(1);
    expect(data[0]!.recordId).toBe("r1");
    unsub();
  });

  it("stops emitting after unsubscribe", async () => {
    await client.subscribe({ filter: {} });
    const states: { data: TestRecord[]; loading: boolean }[] = [];
    const unsub = client.query({ filter: {} }).subscribe((s) => states.push(s));
    await flushPromises();
    const countBefore = states.length;

    unsub();

    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: {},
    });
    await client.pull();
    await flushPromises();

    expect(states.length).toBe(countBefore); // no new emissions after unsub
  });

  it("does not register a sync subscription", async () => {
    const unsub = client.query({ filter: {} }).subscribe(() => {});
    await flushPromises();
    expect(client.getSubscription("anything")).toBeUndefined();
    unsub();
  });
});

describe("liveQuery", () => {
  it("registers a sync subscription on first subscriber", async () => {
    const lq = client.liveQuery({ filter: { name: "hello" } });
    const unsub = lq.subscribe(() => {});
    await flushPromises(); // _subscribe() has multiple async store calls

    const subs = await client.store.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.filter).toMatchObject({ name: "hello" });

    unsub();
    await flushPromises();
  });

  it("removes the sync subscription when last subscriber detaches", async () => {
    const lq = client.liveQuery({ filter: {} });
    const unsub1 = lq.subscribe(() => {});
    const unsub2 = lq.subscribe(() => {});
    await flushPromises();

    unsub1();
    expect((await client.store.listSubscriptions())).toHaveLength(1); // still active

    unsub2();
    await flushPromises(); // unsubscribe() is async
    expect((await client.store.listSubscriptions())).toHaveLength(0);
  });

  it("re-emits when store changes via incoming patches", async () => {
    const lq = client.liveQuery({ filter: {} });
    const states: { data: TestRecord[]; loading: boolean }[] = [];
    const unsub = lq.subscribe((s) => states.push(s));
    await flushPromises(); // wait for subscribe + initial read

    // Simulate an incoming pull patch
    const subId = (await client.store.listSubscriptions())[0]!.subscriptionId;
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: rec() }],
      syncTokens: { [subId]: EMPTY_SYNC_TOKEN },
    });
    await client.pull();
    await flushPromises();

    expect(states.at(-1)!.data).toHaveLength(1);
    unsub();
    await flushPromises();
  });

  it("stores subscription under the given name", async () => {
    const lq = client.liveQuery({ filter: { name: "hello" }, name: "my-notes" });
    const unsub = lq.subscribe(() => {});
    await flushPromises();

    const stored = await client.store.getSubscription("my-notes");
    expect(stored).toBeDefined();
    expect(stored!.name).toBe("my-notes");

    unsub();
    await flushPromises();
  });

  it("emits current data to additional subscribers without re-subscribing", async () => {
    await client.store.write(rec());
    const lq = client.liveQuery({ filter: {} });

    const states1: { data: TestRecord[]; loading: boolean }[] = [];
    const states2: { data: TestRecord[]; loading: boolean }[] = [];

    const unsub1 = lq.subscribe((s) => states1.push(s));
    await flushPromises();
    const unsub2 = lq.subscribe((s) => states2.push(s));
    await flushPromises();

    // Both subscribers get data; only one sync subscription registered
    expect(states1.at(-1)!.data).toHaveLength(1);
    expect(states2.at(-1)!.data).toHaveLength(1);
    expect((await client.store.listSubscriptions())).toHaveLength(1);

    unsub1();
    unsub2();
    await flushPromises();
  });
});

describe("stream", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not throw when transport does not implement stream", async () => {
    // transport has no .stream — subscribe should just skip streaming silently
    await expect(client.subscribe({ filter: {} })).resolves.toBeDefined();
    vi.runAllTimers();
  });

  it("starts stream automatically on subscribe and applies SSE patches", async () => {
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
    // Stream is debounced — flush the timer
    vi.runAllTimers();

    const receivedPatches: unknown[] = [];
    streamClient.onPatches((p) => receivedPatches.push(...p));

    // Verify stream was opened with the subscription
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

  it("batches rapid subscribes into a single stream open", async () => {
    const streamTransport: SyncTransport = {
      ...makeTransport(),
      stream: vi.fn(() => () => {}),
    };

    const streamClient = new SyncClient<TestRecord>(streamTransport);
    await streamClient.subscribe({ filter: { name: "a" } });
    await streamClient.subscribe({ filter: { name: "b" } });
    // Both subscribes happened before the debounce timer fired
    expect(vi.mocked(streamTransport.stream!)).not.toHaveBeenCalled();

    vi.runAllTimers();
    // Single stream open with both subscriptions
    expect(vi.mocked(streamTransport.stream!)).toHaveBeenCalledOnce();
    const callSubs = vi.mocked(streamTransport.stream!).mock.calls[0]![0];
    expect(callSubs).toHaveLength(2);
  });

  it("stops stream when all subscriptions are removed", async () => {
    const stopFn = vi.fn();
    const streamTransport: SyncTransport = {
      ...makeTransport(),
      stream: vi.fn(() => stopFn),
    };

    const streamClient = new SyncClient<TestRecord>(streamTransport);
    const sub = await streamClient.subscribe({ filter: {} });
    vi.runAllTimers(); // open stream
    expect(vi.mocked(streamTransport.stream!)).toHaveBeenCalledOnce();

    await streamClient.unsubscribe(sub.subscriptionId);
    vi.runAllTimers(); // debounced — no active subs → stream stops
    expect(stopFn).toHaveBeenCalledOnce();
    // No new stream opened (no active subs remain)
    expect(vi.mocked(streamTransport.stream!)).toHaveBeenCalledOnce();
  });
});
