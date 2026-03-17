# @sync-subscribe/client

Framework-agnostic sync client for `sync-subscribe`. Manages subscriptions, a local in-memory store, and pull/push cycles against any HTTP transport you provide.

## Concepts

| Term | Description |
|---|---|
| `SyncRecord` | Every synced record must have `recordId`, `createdAt`, `updatedAt`, `revisionCount` |
| `SyncTransport` | Your HTTP adapter — implement `createSubscription`, `pull`, `push` |
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

### 2. Implement `SyncTransport`

The transport is a thin adapter over your HTTP layer. Use `fetch`, `axios`, or anything else.

```ts
import type { SyncTransport } from "@sync-subscribe/client";
import type { SubscriptionFilter, SyncToken } from "@sync-subscribe/core";

function createTransport(): SyncTransport {
  return {
    async createSubscription(filter: SubscriptionFilter, previousSubscriptionId?: string) {
      const res = await fetch("/api/subscriptions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, previousSubscriptionId }),
      });
      return res.json(); // { subscriptionId, syncToken, resetRequired }
    },

    async pull(subscriptionId: string, syncToken: SyncToken) {
      const qs = new URLSearchParams({ subscriptionId, syncToken });
      const res = await fetch(`/api/sync?${qs}`);
      return res.json(); // { patches, syncToken }
    },

    async push(subscriptionId: string, records: unknown[]) {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId, records }),
      });
      return res.json(); // { ok: true } or { conflict: true, serverRecord }
    },
  };
}
```

### 3. Create a client and sync

```ts
import { SyncClient } from "@sync-subscribe/client";

const client = new SyncClient<NoteRecord>(createTransport());

// Subscribe to a filtered subset of records
const sub = await client.subscribe({ filter: { isDeleted: false } });

// Pull all pending patches from the server
await client.pull();

// Read local state (all store methods are async)
const notes = await client.store.getAll();
```

#### Persistent storage with IndexedDB

Pass an `IdbLocalStore` as the second argument to survive page reloads:

```ts
import { SyncClient, IdbLocalStore } from "@sync-subscribe/client";

const client = new SyncClient<NoteRecord>(
  createTransport(),
  new IdbLocalStore("notes-db"),  // data persists across reloads
);
```

The `IdbLocalStore` constructor takes a `dbName` and an optional `storeName` (default `"records"`). Use a unique `dbName` per collection or per user if you need data isolation on the same origin.

## Subscriptions

Each call to `subscribe` registers a filter with the server and stores a `ClientSubscription` locally. You can hold multiple overlapping subscriptions — records matching more than one filter are stored only once in `LocalStore`.

```ts
const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

// Operator-based filter
await client.subscribe({ filter: { createdAt: { $gte: thirtyDaysAgo } } });

// Equality filter — overlaps are fine, deduped locally
await client.subscribe({ filter: { color: "blue" } });

await client.pull(); // fetches patches for both subscriptions
```

Available filter operators: `$gt`, `$gte`, `$lt`, `$lte`, `$ne`, or a plain equality value.

## Mutating records

`mutate` writes the record locally immediately (read-your-own-writes), then pushes it to the server. Returns `true` on success, `false` if the server detected a conflict (in which case the server's version is applied locally).

```ts
// Create
const note: NoteRecord = {
  recordId: crypto.randomUUID(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  revisionCount: 1,
  title: "Hello",
  contents: "World",
  isDeleted: false,
};
await client.mutate(note);

// Update — increment revisionCount on every mutation
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

`onPatches` fires whenever the local store changes, either from an incoming pull or a conflict resolution after a push. Returns an unsubscribe function.

```ts
const unsub = client.onPatches((patches) => {
  for (const patch of patches) {
    if (patch.op === "upsert") console.log("upserted", patch.record.recordId);
    if (patch.op === "delete") console.log("deleted", patch.recordId);
  }
  // Re-read local state (store methods are async)
  client.store.getAll().then((records) => console.log(records));
});

// Later — stop listening
unsub();
```

## Polling

There is no built-in polling timer. Set one up yourself and cancel it on teardown:

```ts
const timer = setInterval(async () => {
  try { await client.pull(); } catch { /* retry next tick */ }
}, 5000);

// On teardown
clearInterval(timer);
```

## React example

```tsx
import { useEffect, useCallback, useRef, useState } from "react";
import { SyncClient } from "@sync-subscribe/client";

// Create once at module level so it survives re-renders
const client = new SyncClient<NoteRecord>(createTransport());

export function NotesList() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const initialized = useRef(false);

  const refresh = useCallback(() => {
    client.store.getAll().then((records) => setNotes(records.filter((n) => !n.isDeleted)));
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    let cancelled = false;

    async function init() {
      await client.subscribe({ filter: { isDeleted: false } });
      await client.pull();
      if (!cancelled) refresh();
    }
    init();

    const unsub = client.onPatches(() => { if (!cancelled) refresh(); });
    const timer = setInterval(() => client.pull().catch(() => {}), 5000);

    return () => {
      cancelled = true;
      unsub();
      clearInterval(timer);
    };
  }, [refresh]);

  return <ul>{notes.map((n) => <li key={n.recordId}>{n.title}</li>)}</ul>;
}
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
| `subscribe(options)` | Register a filter with the server; returns `ClientSubscription` |
| `pull()` | Fetch pending patches for all active subscriptions |
| `mutate(record)` | Write locally + push to server; returns `false` on conflict |
| `onPatches(listener)` | Listen for store changes; returns an unsubscribe function |
| `getSubscription(id)` | Look up a subscription by id |
| `reset()` | Clear all subscriptions and local store (async) |
| `store` | The `LocalStore<T>` instance for direct reads |

### `ILocalStore<T>` — implemented by `LocalStore` and `IdbLocalStore`

All methods are async and return Promises.

| Method | Description |
|---|---|
| `getAll()` | Return all records |
| `getById(recordId)` | Return a single record or `undefined` |
| `applyPatches(patches)` | Apply server patches; returns only the patches that changed local state |
| `write(record)` | Write a record locally (used by `mutate` — not normally called directly) |
| `clear()` | Remove all records (called by `reset()`) |

### `SyncTransport`

```ts
interface SyncTransport {
  createSubscription(filter, previousSubscriptionId?): Promise<ClientSubscription>;
  pull(subscriptionId, syncToken): Promise<{ patches, syncToken }>;
  push(subscriptionId, records): Promise<{ ok: true } | { conflict: true; serverRecord }>;
}
```
