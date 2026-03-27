# @sync-subscribe/client

Framework-agnostic sync client for `sync-subscribe`. Manages subscriptions locally, maintains a local store, and runs pull/push cycles against any HTTP transport you provide.

## Concepts

| Term | Description |
|---|---|
| `SyncRecord` | Every synced record must have `recordId`, `createdAt`, `updatedAt`, `revisionCount` |
| `SyncTransport` | Your HTTP adapter — implement `pull`, `push`, and optionally `stream` |
| `SyncClient` | Orchestrates subscriptions, local state, pull/push, and reactive queries |
| `ILocalStore` | Async interface for local storage — both built-in stores implement it |
| `LocalStore` | In-memory store (default); fast but data is lost on page reload |
| `IdbLocalStore` | IndexedDB-backed store; data persists across page reloads |
| `ClientSubscription` | Tracks a subscription's `subscriptionId`, `filter`, and `syncToken` |
| `SyncQuery<T>` | A reactive handle that follows the store contract: `{ data: T[], loading: boolean }` |

## Installation

```bash
npm install @sync-subscribe/client @sync-subscribe/core
```

## Quick start

### 1. Define your record type

```ts
import type { SyncRecord } from "@sync-subscribe/core";

interface NoteRecord extends SyncRecord {
  title: string;
  contents: string;
  isDeleted: boolean;
}
```

### 2. Create a transport

Use the built-in `createFetchTransport` for standard fetch-based HTTP:

```ts
import { createFetchTransport } from "@sync-subscribe/client";

const transport = createFetchTransport({
  baseUrl: "/api",
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
});
```

Or implement `SyncTransport` yourself for full control:

```ts
import type { SyncTransport } from "@sync-subscribe/client";

const transport: SyncTransport = {
  async pull(subscriptions) {
    const res = await fetch("/api/sync/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptions }), // [{ key, filter, syncToken }]
    });
    return res.json(); // { patches, syncTokens }
  },

  async push(records) {
    const res = await fetch("/api/sync/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    return res.json(); // { ok: true } or { conflict: true, serverRecord }
  },
};
```

### 3. Create a client

```ts
import { SyncClient } from "@sync-subscribe/client";

const client = new SyncClient<NoteRecord>(transport);
```

#### Persistent storage with IndexedDB

Pass an `IdbLocalStore` as the second argument to survive page reloads:

```ts
import { SyncClient, IdbLocalStore } from "@sync-subscribe/client";

const client = new SyncClient<NoteRecord>(
  transport,
  new IdbLocalStore("notes-db"),
);
```

---

## Three ways to use data

There is a deliberate separation between **syncing** data (keeping the local store current) and **querying** data (reading from the local store into memory). This lets you sync more data than you display at any one time.

### 1. Sync-only — keep data current in the store, nothing in memory

Use this when you want data available locally (for fast queries, offline use) but don't need it loaded into JS memory right now.

```ts
// Keeps last 30 days synced. Automatically starts pull + SSE stream.
const sub = await client.subscribe({
  filter: { createdAt: { $gte: Date.now() - 30 * 24 * 60 * 60 * 1000 } },
  name: "last-30-days",
});

// Later, remove it
await client.unsubscribe(sub.subscriptionId);
```

`subscribe()` handles pull scheduling and SSE stream management automatically. Multiple rapid `subscribe()` calls are debounced into a single stream reconnect.

### 2. Query — read from the local store reactively

Use this when data is already being synced (by a separate `subscribe()`) but you want a filtered, reactive, in-memory view of it. No additional sync subscription is registered.

```ts
// client.query() returns a SyncQuery<T> — a store-contract object.
// Nothing happens until you call .subscribe() on it.
const todayQuery = client.query({
  filter: { createdAt: { $gte: startOfToday } },
});

// Follow the store contract: subscribe(run) => unsubscribe
const unsub = todayQuery.subscribe(({ data, loading }) => {
  if (loading) return;
  console.log("today's notes:", data);
});

unsub(); // stop listening
```

`query()` is a sub-filter of whatever is already synced. It reads from the local store and re-runs whenever the store changes (pull patches or mutations). Loading starts `true` and becomes `false` after the first local read.

### 3. Live query — sync + query combined (common case)

Use this when the sync filter and the query filter are the same, or when you want the query to manage its own subscription lifecycle.

```ts
// client.liveQuery() registers a sync subscription when the first
// subscriber attaches, and removes it when the last subscriber detaches.
const notesQuery = client.liveQuery({
  filter: { isDeleted: false },
  name: "active-notes",
});

const unsub = notesQuery.subscribe(({ data, loading }) => {
  if (loading) return;
  renderNotes(data);
});

unsub(); // stops listening AND removes the sync subscription (if last subscriber)
```

### Pattern: large sync window, narrow display window

```ts
// Sync 30 days in the background — data lives in local store, not in memory.
// This runs once at app startup (or in a root component).
await client.subscribe({
  filter: { createdAt: { $gte: thirtyDaysAgo } },
  name: "background-30d",
});

// In a component: query only today's slice — fast, no extra network request.
// The data is already in the local store from the background subscription.
const todayQuery = client.query({ filter: { createdAt: { $gte: startOfToday } } });

todayQuery.subscribe(({ data, loading }) => {
  renderNotes(data); // instant — no loading spinner needed
});
```

---

## The store contract

`SyncQuery<T>` follows the [Svelte store contract](https://svelte.dev/docs/svelte/stores#Store-contract), making it usable directly in Svelte templates, with `useSyncExternalStore` in React, or with any store-aware utility.

```ts
interface SyncQuery<T extends SyncRecord> {
  subscribe(
    run: (value: { data: T[]; loading: boolean }) => void,
    invalidate?: () => void,
  ): () => void; // returns unsubscribe
}
```

**In Svelte:**
```svelte
<script>
  const notes = client.liveQuery({ filter: { isDeleted: false } });
</script>

{#if $notes.loading}
  <p>Loading…</p>
{:else}
  {#each $notes.data as note}
    <NoteCard {note} />
  {/each}
{/if}
```

**In React (proposed `useQuery` hook from `@sync-subscribe/client-react`):**
```tsx
const { data, loading } = useQuery(client.query({ filter: { isDeleted: false } }));
// or the combined version:
const { data, loading } = useQuery(client.liveQuery({ filter: { isDeleted: false } }));
```

---

## Subscriptions

`subscribe` registers a filter locally and returns a `ClientSubscription`. The filter is sent to the server on every pull cycle or SSE stream request. Multiple overlapping subscriptions are fine — records are stored only once in the local store.

```ts
const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

const sub1 = await client.subscribe({ filter: { createdAt: { $gte: thirtyDaysAgo } } });
const sub2 = await client.subscribe({ filter: { color: "blue" } });

// Both subscriptions are batched into a single pull request.
// The SSE stream (if transport supports it) is restarted once to include both.
```

Available filter operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$or`, `$and`, `$nor`.

### Named subscriptions

Pass `name` to persist and restore subscription state across sessions (requires `IdbLocalStore`):

```ts
await client.subscribe({ filter: { isDeleted: false }, name: "active-notes" });
```

On the next session, `subscribe` with the same `name` and same filter reuses the stored `syncToken`, enabling incremental sync instead of a full re-fetch.

### Updating a subscription

```ts
await client.updateSubscription(sub.subscriptionId, { color: "red" });
```

The client runs gap and eviction analysis locally: it detects whether any records matching the new filter are not yet cached (gap), fetches them, and evicts records that only the old filter needed.

### Removing a subscription

```ts
await client.unsubscribe(sub.subscriptionId);
```

Removes the subscription from the local store and restarts the SSE stream without it. If no subscriptions remain, the stream is stopped.

---

## Mutating records

`mutate` writes the record locally immediately (read-your-own-writes), then pushes to the server. `updatedAt` and `revisionCount` are stamped automatically — do not set them yourself.

Returns `true` on success, `false` if the server detected a conflict (server record wins).

```ts
// Create — provide recordId and createdAt; mutate() handles the rest
await client.mutate({
  recordId: crypto.randomUUID(),
  createdAt: Date.now(),
  title: "Hello",
  contents: "World",
  isDeleted: false,
} as NoteRecord);

// Update — just spread and change fields; mutate() increments revisionCount
await client.mutate({ ...note, contents: "Updated" });

// Soft-delete
await client.mutate({ ...note, isDeleted: true });
```

---

## Listening for patches

`onPatches` fires whenever the local store changes from an incoming pull, stream event, or conflict resolution. Returns an unsubscribe function.

```ts
const unsub = client.onPatches((patches) => {
  for (const patch of patches) {
    if (patch.op === "upsert") console.log("upserted", patch.record.recordId);
    if (patch.op === "delete") console.log("deleted", patch.recordId);
  }
});

unsub(); // stop listening
```

This is the low-level primitive that `query()` and `liveQuery()` build on. Prefer those for UI code.

---

## SSE streaming

If your transport implements `stream`, the client opens a persistent SSE connection automatically when you call `subscribe()`. You do not manage the stream directly — it is started, restarted (when subscriptions change), and stopped (when all subscriptions are removed) internally.

```ts
// Transport with SSE support
const transport: SyncTransport = {
  // pull, push as before...

  stream(subscriptions, onMessage, onError) {
    const es = new EventSource("/api/sync/stream");
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onerror = (e) => onError?.(new Error("SSE error"));
    return () => es.close(); // cleanup
  },
};

// SSE starts automatically when subscribe() is called.
// It restarts whenever subscriptions change, debounced 20 ms.
await client.subscribe({ filter: { isDeleted: false } });
```

---

## Polling

There is no built-in polling timer. Set one up yourself:

```ts
const timer = setInterval(async () => {
  try { await client.pull(); } catch { /* retry next tick */ }
}, 5000);

clearInterval(timer); // on teardown
```

---

## Resetting state

Call `reset()` on logout or account switch — it stops the SSE stream, clears all subscriptions, and empties the local store.

```ts
await client.reset();
```

---

## API reference

### `SyncClient<T>`

| Method | Returns | Description |
|---|---|---|
| `subscribe(options)` | `Promise<ClientSubscription>` | Sync a filter to local store; auto-starts pull + stream |
| `unsubscribe(id)` | `Promise<void>` | Remove a subscription; restarts stream without it |
| `updateSubscription(id, filter)` | `Promise<ClientSubscription>` | Replace a subscription's filter; handles gap/eviction |
| `query(options)` | `SyncQuery<T>` | Reactive local-store query; no sync subscription |
| `liveQuery(options)` | `SyncQuery<T>` | Reactive query that manages its own sync subscription |
| `mutate(record)` | `Promise<boolean>` | Write locally + push to server; stamps `updatedAt`/`revisionCount` |
| `pull()` | `Promise<void>` | Fetch pending patches for all active subscriptions |
| `schedulePull(delayMs?)` | `Promise<void>` | Debounced pull — collapses rapid calls into one request |
| `onPatches(listener)` | `() => void` | Low-level patch listener; returns unsubscribe |
| `getSubscription(key)` | `ClientSubscription \| undefined` | Look up by `subscriptionId` or `name` |
| `reset()` | `Promise<void>` | Stop stream, clear subscriptions and local store |
| `store` | `ILocalStore<T>` | Direct access to the local store |

### `SyncQuery<T>` — store contract

```ts
interface SyncQuery<T extends SyncRecord> {
  subscribe(
    run: (value: { data: T[]; loading: boolean }) => void,
    invalidate?: () => void,
  ): () => void;
}
```

`liveQuery` vs `query`:

| | `query()` | `liveQuery()` |
|---|---|---|
| Registers a sync subscription | No | Yes (on first subscriber) |
| Removes sync subscription on cleanup | No | Yes (on last unsubscribe) |
| Reads from local store | Yes | Yes |
| Reacts to pull/stream patches | Yes | Yes |
| Use when | Data already synced elsewhere | Query filter === sync filter |

### `SyncTransport`

```ts
interface SyncTransport {
  pull(subscriptions: { key: string; filter: SubscriptionFilter; syncToken: SyncToken }[]): Promise<{
    patches: SyncPatch<SyncRecord>[];
    syncTokens: Record<string, SyncToken>;
  }>;

  push(records: SyncRecord[]): Promise<
    | { ok: true; serverUpdatedAt: number }
    | { conflict: true; serverRecord: SyncRecord }
  >;

  stream?(
    subscriptions: { key: string; filter: SubscriptionFilter; syncToken: SyncToken }[],
    onMessage: (event: { patches: SyncPatch<SyncRecord>[]; syncTokens: Record<string, SyncToken> }) => void,
    onError?: (err: Error) => void,
  ): () => void;
}
```

### `ILocalStore<T>` — implemented by `LocalStore` and `IdbLocalStore`

| Method | Description |
|---|---|
| `getAll()` | Return all records |
| `getById(recordId)` | Return a single record or `undefined` |
| `query(filter)` | Return records matching a filter |
| `applyPatches(patches)` | Apply server patches; returns only patches that changed local state |
| `write(record)` | Write a record locally (used by `mutate`) |
| `evict(filter)` | Remove records matching a filter without deleting them from the server |
| `reconstructSyncToken(filter)` | Build a sync token from the latest locally-cached record matching `filter` |
| `clear()` | Remove all records |
