# @sync-subscribe/client

Framework-agnostic sync client for `sync-subscribe`. Manages subscriptions locally, maintains a local store, and runs pull/push cycles against any HTTP transport you provide.

## Concepts

| Term | Description |
|---|---|
| `SyncRecord` | Every synced record must have `recordId`, `createdAt`, `updatedAt`, `revisionCount` |
| `SyncTransport` | Your HTTP adapter — implement `pull`, `push`, and optionally `stream` |
| `SyncClient` | Orchestrates subscriptions, local state, pull, push, and patch listeners |
| `ILocalStore` | Async interface for local storage — both built-in stores implement it |
| `LocalStore` | In-memory store (default); fast but data is lost on page reload |
| `IdbLocalStore` | IndexedDB-backed store; data persists across page reloads |
| `ClientSubscription` | Tracks a subscription's `subscriptionId`, `filter`, and `syncToken` |

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

### 3. Create a client and sync

```ts
import { SyncClient } from "@sync-subscribe/client";

const client = new SyncClient<NoteRecord>(transport);

// Register a subscription locally (no server call)
await client.subscribe({ filter: { isDeleted: false } });

// Pull pending patches from the server
await client.pull();

// Read local state
const notes = await client.store.getAll();
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

## Subscriptions

`subscribe` registers a filter locally and returns a `ClientSubscription`. The filter is sent to the server on every `pull` or `stream` call. You can hold multiple overlapping subscriptions — records matching more than one filter are stored only once in the local store.

```ts
const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

// Time-range filter
await client.subscribe({ filter: { createdAt: { $gte: thirtyDaysAgo } } });

// Equality filter — overlaps are fine, deduped locally
await client.subscribe({ filter: { color: "blue" } });

await client.pull(); // fetches patches for both subscriptions in one request
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
// Replace the filter on an existing subscription
await client.updateSubscription(sub.subscriptionId, { color: "red" });
```

The client runs gap and eviction analysis locally: it detects whether any records matching the new filter are not yet cached (gap), fetches them, and evicts records that only the old filter needed.

## Mutating records

`mutate` writes the record locally immediately (read-your-own-writes), then pushes to the server. Returns `true` on success, `false` if the server detected a conflict (server record wins).

```ts
// Create
await client.mutate({
  recordId: crypto.randomUUID(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  revisionCount: 1,
  title: "Hello",
  contents: "World",
  isDeleted: false,
});

// Update — always increment revisionCount
await client.mutate({
  ...note,
  contents: "Updated",
  updatedAt: Date.now(),
  revisionCount: note.revisionCount + 1,
});

// Soft-delete
await client.mutate({
  ...note,
  isDeleted: true,
  updatedAt: Date.now(),
  revisionCount: note.revisionCount + 1,
});
```

`revisionCount` is a "work done" counter used for conflict resolution — increment it on every local change.

## Listening for changes

`onPatches` fires whenever the local store changes from an incoming pull or conflict resolution. Returns an unsubscribe function.

```ts
const unsub = client.onPatches((patches) => {
  for (const patch of patches) {
    if (patch.op === "upsert") console.log("upserted", patch.record.recordId);
    if (patch.op === "delete") console.log("deleted", patch.recordId);
  }
});

unsub(); // stop listening
```

## SSE streaming

If your transport implements `stream`, the client can open a persistent SSE connection instead of polling:

```ts
// stream() returns a cleanup function
const stop = client.stream();

// Later, on teardown
stop();
```

Only `active` subscriptions participate in the stream. The client sends `[{ key, filter, syncToken }]` via POST so the server knows which filters to watch and where each subscription left off.

## Polling

There is no built-in polling timer. Set one up yourself:

```ts
const timer = setInterval(async () => {
  try { await client.pull(); } catch { /* retry next tick */ }
}, 5000);

clearInterval(timer); // on teardown
```

## Resetting state

Call `reset()` on logout or account switch — it clears all subscriptions and empties the local store.

```ts
await client.reset();
```

## API reference

### `SyncClient<T>`

| Method | Description |
|---|---|
| `subscribe(options)` | Register a filter locally; returns `ClientSubscription` |
| `updateSubscription(id, filter)` | Replace a subscription's filter; handles gap/eviction locally |
| `pull()` | Fetch pending patches for all active subscriptions |
| `schedulePull(delayMs?)` | Debounced pull — collapses rapid concurrent calls into one request |
| `mutate(record)` | Write locally + push to server; returns `false` on conflict |
| `stream()` | Open SSE stream for all active subscriptions; returns cleanup function |
| `onPatches(listener)` | Listen for store changes; returns an unsubscribe function |
| `getSubscription(key)` | Look up a subscription by `subscriptionId` or `name` |
| `reset()` | Clear all subscriptions and local store |
| `store` | The `ILocalStore<T>` instance for direct reads |

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
