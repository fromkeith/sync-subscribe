# @sync-subscribe/client-react

React bindings for `@sync-subscribe/client`. Provides a context provider and hooks for subscribing to synced data, making mutations, and automatically replaying changes when the device comes back online.

## Installation

```bash
npm install @sync-subscribe/client-react @sync-subscribe/client @sync-subscribe/core
```

React ≥ 18 is a peer dependency.

## Quick start

```tsx
import { SyncClient, IdbLocalStore, createFetchTransport } from "@sync-subscribe/client";
import { SyncProvider, useRecords, useMutate } from "@sync-subscribe/client-react";

// Create the client once at module level (outside components)
const client = new SyncClient(
  createFetchTransport({ baseUrl: "/api" }),
  new IdbLocalStore("my-app-db"), // persists across reloads; omit for in-memory
);

function App() {
  return (
    <SyncProvider client={client}>
      <NotesList />
    </SyncProvider>
  );
}

function NotesList() {
  const notes = useRecords<NoteRecord>({ filter: { isDeleted: false } });
  const mutate = useMutate<NoteRecord>();

  async function handleDelete(note: NoteRecord) {
    await mutate({
      ...note,
      isDeleted: true,
      updatedAt: Date.now(),
      revisionCount: note.revisionCount + 1,
    });
  }

  return (
    <ul>
      {notes.map((n) => (
        <li key={n.recordId}>
          {n.title}
          <button onClick={() => handleDelete(n)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
```

## API

### `<SyncProvider client={client}>`

Provides the `SyncClient` to all child hooks. Place it once near the root of your app.

The provider also manages the **offline mutation queue**. Mutations made while the device is offline are written to the local store immediately (read-your-own-writes) and pushed to the server automatically when connectivity is restored.

```tsx
<SyncProvider client={client}>
  <App />
</SyncProvider>
```

---

### `useRecords<T>(options)`

Subscribes to a filtered view of records and returns them as a live array.

```ts
const notes = useRecords<NoteRecord>({
  filter: { isDeleted: false },
  name: "active-notes", // optional — persists subscription state across sessions
});
```

**What it does:**
- On mount: registers a subscription locally for `filter`, pulls the initial batch, and opens an SSE stream
- Re-renders on every incoming patch (from pull, stream, or conflict resolution)
- When `filter` changes: registers a new subscription, replacing the old one. Gap analysis runs locally to determine whether any records matching the new filter are not yet cached — if so they are fetched before joining the stream. Records that only the old filter needed are evicted.
- Filters the local store client-side with `matchesFilter`, so multiple overlapping `useRecords` calls with different filters work correctly

**Filter operators:**

```ts
// Equality
useRecords({ filter: { color: "blue" } });

// Comparison operators
useRecords({ filter: { createdAt: { $gte: Date.now() - 30 * 24 * 60 * 60 * 1000 } } });

// Multiple conditions (all must match)
useRecords({ filter: { isDeleted: false, category: "work" } });

// $or
useRecords({ filter: { $or: [{ color: "blue" }, { color: "red" }] } });
```

**Stable filter references:**

`useRecords` serialises the filter to detect changes, so passing an inline object literal is safe — it won't trigger unnecessary re-subscriptions:

```tsx
// Fine — does NOT re-subscribe on every render
const notes = useRecords({ filter: { isDeleted: false } });
```

---

### `useMutate<T>()`

Returns a `mutate` function scoped to the nearest `SyncProvider`.

```ts
const mutate = useMutate<NoteRecord>();
```

**`mutate(record): Promise<boolean>`**
- Writes the record to the local store immediately (read-your-own-writes)
- If **online**: pushes to the server; returns `true` on success, `false` on conflict (server record wins and is applied locally)
- If **offline**: queues the push and returns `true` optimistically; the push is retried when the device comes back online

Always increment `revisionCount` on every change:

```ts
// Create
await mutate({
  recordId: crypto.randomUUID(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  revisionCount: 1,
  title: "New note",
  isDeleted: false,
});

// Update
await mutate({
  ...existing,
  title: "Edited title",
  updatedAt: Date.now(),
  revisionCount: existing.revisionCount + 1,
});

// Soft-delete
await mutate({
  ...existing,
  isDeleted: true,
  updatedAt: Date.now(),
  revisionCount: existing.revisionCount + 1,
});
```

---

### `useSyncClient<T>()`

Escape hatch to access the raw `SyncClient` from context.

```ts
const client = useSyncClient<NoteRecord>();
await client.reset(); // e.g. on logout
```

---

## Offline behaviour

`SyncProvider` listens to the browser's `online` event. When the device reconnects, it drains the pending queue in the order mutations were made, deduplicating by `recordId` (only the latest mutation per record is sent).

```
offline  →  mutate(noteA v1)  →  mutate(noteA v2)  →  online
                                                          ↓
                                               push(noteA v2)   ← only latest sent
```

If a push fails after reconnecting (e.g. the server is still unreachable), the record is re-queued and retried on the next `online` event.

---

## Multiple subscriptions

Multiple `useRecords` calls create independent subscriptions. The local store deduplicates records by `recordId`, so records matching more than one filter are stored only once. Each hook filters client-side to return its own view.

```tsx
// Two subscriptions, no duplicates in the local store
const recentNotes = useRecords({ filter: { createdAt: { $gte: thirtyDaysAgo } } });
const blueNotes   = useRecords({ filter: { color: "blue" } });
```
