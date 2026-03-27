import { describe, it, expect, vi, afterEach } from "vitest";
import { provider } from "svelteprovider";
import { SyncClient, InMemoryStore } from "@sync-subscribe/client";
import type { SyncTransport, QueryEntries } from "@sync-subscribe/client";
import type { SyncRecord } from "@sync-subscribe/core";
import { createSyncClientProvider, createLiveQuery, createQuery } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Note extends SyncRecord {
  title: string;
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    recordId: "n1",
    createdAt: 1000,
    updatedAt: 2000,
    revisionCount: 1,
    title: "hello",
    ...overrides,
  };
}

function makeTransport(): SyncTransport {
  return {
    pull: vi.fn(async () => ({ patches: [], syncTokens: {} })),
    push: vi.fn(async () => ({ ok: true as const, serverUpdatedAt: 3000 })),
  };
}

// Drains the full microtask + macrotask queue — needed for multi-step async
// chains inside providers (clientProvider build → outer provider build → liveQuery subscribe).
const flushPromises = () => new Promise<void>((r) => setTimeout(r, 0));

// Subscribe to a provider, run fn, collect all non-null emitted values, then unsub.
async function collect<T>(
  p: { subscribe: (run: (v: T | null) => void) => () => void },
  fn: () => Promise<void> | void,
): Promise<T[]> {
  const values: T[] = [];
  const unsub = p.subscribe((v) => {
    if (v !== null) values.push(v as T);
  });
  await fn();
  unsub();
  return values;
}

// Wraps a SyncClient in a svelteprovider factory so it can be passed to
// createLiveQuery / createQuery as the clientProvider argument.
function wrapClient<T extends SyncRecord>(client: SyncClient<T>) {
  // Returns the factory (() => Provider<SyncClient<T>>), not the instance.
  // mutate() calls clientProvider().promise, so the factory is required.
  return provider(async () => client);
}

// ---------------------------------------------------------------------------
// createSyncClientProvider
// ---------------------------------------------------------------------------

describe("createSyncClientProvider", () => {
  it("resolves to a SyncClient instance on first subscribe", async () => {
    const transport = makeTransport();
    const store = new InMemoryStore<Note>();
    const factory = createSyncClientProvider(transport, store);

    let resolved: SyncClient<Note> | null = null;
    const values = await collect<SyncClient<Note>>(factory(), flushPromises);
    resolved = values[values.length - 1] ?? null;

    expect(resolved).toBeInstanceOf(SyncClient);
  });

  it("returns the same provider instance on repeated calls", () => {
    const transport = makeTransport();
    const store = new InMemoryStore<Note>();
    const factory = createSyncClientProvider(transport, store);
    expect(factory()).toBe(factory());
  });

  it("passes the schema to the SyncClient when provided", async () => {
    const transport = makeTransport();
    const store = new InMemoryStore<Note>();
    const schema = { validate: (r: unknown) => r as Note };
    const factory = createSyncClientProvider(transport, store, schema as never);

    const values = await collect<SyncClient<Note>>(factory(), flushPromises);
    expect(values[values.length - 1]).toBeInstanceOf(SyncClient);
  });
});

// ---------------------------------------------------------------------------
// createLiveQuery
// ---------------------------------------------------------------------------

describe("createLiveQuery", () => {
  it("calls client.liveQuery with the given filter", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const liveQuerySpy = vi.spyOn(client, "liveQuery");

    const liveQueryFactory = createLiveQuery<Note>(wrapClient(client));
    await collect(liveQueryFactory({ filter: { title: "hello" } }), flushPromises);

    expect(liveQuerySpy).toHaveBeenCalledWith({ filter: { title: "hello" } });
  });

  it("passes name option through to client.liveQuery", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const liveQuerySpy = vi.spyOn(client, "liveQuery");

    const liveQueryFactory = createLiveQuery<Note>(wrapClient(client));
    await collect(liveQueryFactory({ filter: {}, name: "my-notes" }), flushPromises);

    expect(liveQuerySpy).toHaveBeenCalledWith({ filter: {}, name: "my-notes" });
  });

  it("emits loading: true then loading: false after the initial query resolves", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());

    const liveQueryFactory = createLiveQuery<Note>(wrapClient(client));
    const values = await collect<QueryEntries<Note>>(
      liveQueryFactory({ filter: {} }),
      flushPromises,
    );

    expect(values[0]).toMatchObject({ data: [], loading: true });
    expect(values[values.length - 1]).toMatchObject({ loading: false });
  });

  it("emits records that arrive via pull", async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport();
      vi.mocked(transport.pull).mockResolvedValueOnce({
        patches: [{ op: "upsert", record: note() }],
        syncTokens: {},
      });

      const client = new SyncClient<Note>(transport, new InMemoryStore());
      const liveQueryFactory = createLiveQuery<Note>(wrapClient(client));

      const p = liveQueryFactory({ filter: {} });
      let lastValue: QueryEntries<Note> | null = null;
      const unsub = p.subscribe((v) => { if (v) lastValue = v; });

      // Flush microtasks for the provider chain to build (no timers needed yet).
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // Advance past the schedulePull debounce (20ms).
      await vi.advanceTimersByTimeAsync(30);
      // Let pull response and patch listeners propagate through microtasks.
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(lastValue?.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ title: "hello" })]),
      );
      expect(lastValue?.loading).toBe(false);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers a sync subscription via client.subscribe", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const subscribeSpy = vi.spyOn(client, "subscribe");

    const liveQueryFactory = createLiveQuery<Note>(wrapClient(client));
    await collect(liveQueryFactory({ filter: {} }), flushPromises);

    expect(subscribeSpy).toHaveBeenCalledWith({ filter: {} });
  });

  it("calls client.mutate via the mutate action", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const mutateSpy = vi.spyOn(client, "mutate");

    const liveQueryFactory = createLiveQuery<Note>(wrapClient(client));
    const p = liveQueryFactory({ filter: {} });

    const unsub = p.subscribe(() => {});
    await flushPromises();

    await p.mutate(note());
    expect(mutateSpy).toHaveBeenCalledWith(note());
    unsub();
  });

  it("re-runs with new filter when options change", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const liveQuerySpy = vi.spyOn(client, "liveQuery");

    const liveQueryFactory = createLiveQuery<Note>(wrapClient(client));
    const unsub = liveQueryFactory({ filter: { title: "hello" } }).subscribe(() => {});
    await flushPromises();

    // Calling the factory again updates the options store → provider re-builds
    liveQueryFactory({ filter: { title: "world" } });
    await flushPromises();

    expect(liveQuerySpy).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { title: "world" } }),
    );
    unsub();
  });
});

// ---------------------------------------------------------------------------
// createQuery
// ---------------------------------------------------------------------------

describe("createQuery", () => {
  it("calls client.query with the given filter", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const querySpy = vi.spyOn(client, "query");

    const queryFactory = createQuery<Note>(wrapClient(client));
    await collect(queryFactory({ filter: { title: "hello" } }), flushPromises);

    expect(querySpy).toHaveBeenCalledWith({ filter: { title: "hello" } });
  });

  it("does not register a sync subscription (local store only)", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const subscribeSpy = vi.spyOn(client, "subscribe");

    const queryFactory = createQuery<Note>(wrapClient(client));
    await collect(queryFactory({ filter: {} }), flushPromises);

    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(transport.pull).not.toHaveBeenCalled();
  });

  it("emits loading: true then loading: false", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());

    const queryFactory = createQuery<Note>(wrapClient(client));
    const values = await collect<QueryEntries<Note>>(
      queryFactory({ filter: {} }),
      flushPromises,
    );

    expect(values[0]).toMatchObject({ loading: true });
    expect(values[values.length - 1]).toMatchObject({ loading: false });
  });

  it("reflects records already in the local store", async () => {
    const transport = makeTransport();
    const store = new InMemoryStore<Note>();
    await store.write(note());

    const client = new SyncClient<Note>(transport, store);
    const queryFactory = createQuery<Note>(wrapClient(client));

    const p = queryFactory({ filter: {} });
    let lastValue: QueryEntries<Note> | null = null;
    const unsub = p.subscribe((v) => { if (v) lastValue = v; });
    await flushPromises();

    expect(lastValue?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "hello" })]),
    );
    unsub();
  });

  it("calls client.mutate via the mutate action", async () => {
    const transport = makeTransport();
    const client = new SyncClient<Note>(transport, new InMemoryStore());
    const mutateSpy = vi.spyOn(client, "mutate");

    const queryFactory = createQuery<Note>(wrapClient(client));
    const p = queryFactory({ filter: {} });

    const unsub = p.subscribe(() => {});
    await flushPromises();

    await p.mutate(note());
    expect(mutateSpy).toHaveBeenCalledWith(note());
    unsub();
  });
});
