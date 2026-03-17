# @sync-subscribe/server

Framework-agnostic sync server for `sync-subscribe`. Wire `SyncHandler` into any HTTP framework (Express, Hono, Fastify, …) to expose pull, push, and SSE streaming endpoints for your clients.

## Concepts

| Term | Description |
|---|---|
| `SyncRecord` | Every synced record must have `recordId`, `createdAt`, `updatedAt`, `revisionCount` |
| `SyncStore` | Your storage adapter — implement `getRecordsSince`, `upsert`, `getById` |
| `SubscriptionManager` | Tracks active subscriptions; in-memory by default, pluggable for persistence |
| `SyncHandler` | Orchestrates pull / push / subscribe logic; decoupled from HTTP |
| `clientFilter` | Filter the client requested (subset of fields, visible to client) |
| `serverFilter` | Complete effective filter used for queries: `clientFilter ⊆ serverFilter` |

## Installation

```bash
npm install @sync-subscribe/server @sync-subscribe/core
```

## Quick start

### 1. Define your record type

```ts
import type { SyncRecord } from "@sync-subscribe/core";

interface NoteRecord extends SyncRecord {
  userId: string;
  title: string;
  contents: string;
  isDeleted: boolean;
}
```

### 2. Implement `SyncStore`

```ts
import type { SyncStore } from "@sync-subscribe/server";
import type { SyncPatch, SyncToken, SubscriptionFilter } from "@sync-subscribe/core";
import { decodeSyncToken } from "@sync-subscribe/core";

class NotesStore implements SyncStore<NoteRecord> {
  async getRecordsSince(
    filter: SubscriptionFilter,
    since: SyncToken
  ): Promise<SyncPatch<NoteRecord>[]> {
    const token = decodeSyncToken(since);
    // Query your DB: return records matching `filter` updated after `token`.
    // Results must be ordered by (updatedAt ASC, revisionCount ASC, recordId ASC).
    // ...
  }

  async upsert(record: NoteRecord): Promise<NoteRecord> {
    // INSERT OR REPLACE / ON CONFLICT DO UPDATE
    return record;
  }

  async getById(recordId: string): Promise<NoteRecord | null> {
    // Return record or null
  }
}
```

### 3. Wire up routes

```ts
import { SubscriptionManager, SyncHandler } from "@sync-subscribe/server";
import type { UpdateSubscriptionRequest } from "@sync-subscribe/server";
import type { SyncToken, SubscriptionFilter } from "@sync-subscribe/core";

const store = new NotesStore();
const subscriptions = new SubscriptionManager<NoteRecord>();
const handler = new SyncHandler(store, subscriptions, {
  readonlyFields: ["createdAt"],           // clients cannot overwrite these
  onRecordsChanged: (records) => { /* notify SSE clients */ },
});

// PUT /subscriptions — create or update a subscription
app.put("/subscriptions", async (req, res) => {
  const { filter, previousSubscriptionId } = req.body as {
    filter: SubscriptionFilter;
    previousSubscriptionId?: string;
  };
  // Merge server-enforced fields (e.g. userId) — invisible to the client.
  const serverAdditions = { userId: req.user.id };
  const result = await handler.updateSubscription(filter, serverAdditions, previousSubscriptionId);
  res.json(result); // { subscriptionId, syncToken, resetRequired }
});

// GET /sync?subscriptionId=X&syncToken=Y — pull
app.get("/sync", async (req, res) => {
  const { subscriptionId, syncToken } = req.query as Record<string, string>;
  const result = await handler.pull({ subscriptionId, syncToken: syncToken as SyncToken });
  res.json(result); // { patches, syncToken }
});

// POST /sync — push records from client
app.post("/sync", async (req, res) => {
  const { subscriptionId, records } = req.body;
  const result = await handler.push({ subscriptionId, records });
  res.json(result); // { ok: true } or { conflict: true, serverRecord }
});
```

## SSE streaming

Clients can subscribe to a persistent push stream instead of polling.

```ts
// GET /sync/stream?subscriptionId=X&syncToken=Y
app.get("/sync/stream", async (req, res) => {
  const { subscriptionId, syncToken } = req.query as Record<string, string>;

  const sub = subscriptions.get(subscriptionId);
  if (!sub) return res.status(400).json({ error: "Unknown subscription" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  // Send initial batch
  const initial = await handler.pull({ subscriptionId, syncToken: syncToken as SyncToken });
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  // Register for push notifications (your own registry)
  sseClients.get(subscriptionId)?.add(res);

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(subscriptionId)?.delete(res);
  });
});
```

Push to registered SSE clients inside `onRecordsChanged`:

```ts
const handler = new SyncHandler(store, subscriptions, {
  onRecordsChanged: (records) => {
    for (const [subId, clients] of sseClients) {
      const sub = subscriptions.get(subId);
      if (!sub) continue;

      const matching = records.filter((r) =>
        matchesFilter(r as Record<string, unknown>, sub.serverFilter)
      );
      if (matching.length === 0) continue;

      const patches = matching.map((r) => ({ op: "upsert" as const, record: r }));
      const lastRecord = matching[matching.length - 1]!;
      subscriptions.updateSyncToken(subId, lastRecord);
      const newToken = subscriptions.get(subId)!.syncToken;

      const payload = `data: ${JSON.stringify({ patches, syncToken: newToken })}\n\n`;
      for (const res of clients) res.write(payload);
    }
  },
});
```

## Server-initiated writes

Use `serverUpsert` for background jobs, webhooks, or inter-service writes. Unlike `push`, there is no conflict resolution — the server's intent always wins.

```ts
const stored = await handler.serverUpsert({
  recordId: "note-abc",
  userId: "system",
  title: "Auto-generated",
  contents: "...",
  isDeleted: false,
  createdAt: 0,  // overwritten by serverUpsert
  updatedAt: 0,  // overwritten by serverUpsert
  revisionCount: 0,  // incremented by serverUpsert
});
```

`onRecordsChanged` fires after every `serverUpsert`, so SSE clients are notified automatically.

## Persistent subscriptions

By default subscriptions are lost on restart. Provide a `SubscriptionStore` backed by your database to survive restarts.

```ts
import type { SubscriptionStore, ServerSubscription } from "@sync-subscribe/server";

class DbSubscriptionStore implements SubscriptionStore {
  async save(sub: ServerSubscription) { /* upsert row */ }
  async get(id: string) { /* SELECT by id */ }
  async delete(id: string) { /* DELETE by id */ }
  async getAll() { /* SELECT * */ }
}

const subscriptions = new SubscriptionManager(new DbSubscriptionStore());
await subscriptions.initialize(); // warm in-memory cache on startup
```

## Readonly fields

Fields listed in `readonlyFields` are copied from the server record before conflict resolution. Clients cannot overwrite them even if they try.

```ts
new SyncHandler(store, subscriptions, {
  readonlyFields: ["createdAt", "userId"],
});
```

## Conflict resolution

On `push`, if the server's `revisionCount` is higher than the incoming record (or equal with an older `updatedAt`), the push returns a conflict:

```ts
// { conflict: true, serverRecord: NoteRecord }
```

The client should apply the server record locally and retry if needed. The `revisionCount` acts as a "work done" counter — it doesn't depend on clocks.

## Partial sync on filter update

When a subscription filter changes, `updateSubscription` normally resets to `EMPTY_SYNC_TOKEN` (full re-sync). You can avoid this for the common case where the filter only expands by implementing `computePartialSyncToken` on your `SyncStore`:

```ts
async computePartialSyncToken(
  oldFilter: SubscriptionFilter,
  newFilter: SubscriptionFilter,
  existingToken: SyncToken
): Promise<SyncToken> {
  // Find the oldest record newly in scope (in newFilter but not oldFilter).
  // Return a token positioned just before it so the client only pulls the delta.
  // Return existingToken if the filter only narrowed (no new records to send).
  // Return EMPTY_SYNC_TOKEN to fall back to a full re-sync.
}
```

## API reference

### `SyncHandler<T>`

| Method | Description |
|---|---|
| `updateSubscription(clientFilter, serverAdditions?, previousId?)` | Create or update a subscription. Returns `{ subscriptionId, syncToken, resetRequired }` |
| `pull(req)` | Return patches since `syncToken` for a subscription |
| `push(req)` | Accept client records, resolve conflicts, persist, fire `onRecordsChanged` |
| `serverUpsert(record)` | Write a record as the server; no conflict resolution |

### `SubscriptionManager<T>`

| Method | Description |
|---|---|
| `create(clientFilter, serverAdditions?)` | Create a new subscription |
| `update(previousId, clientFilter, serverAdditions?)` | Replace an existing subscription |
| `get(subscriptionId)` | Synchronous cache lookup |
| `updateSyncToken(subscriptionId, lastRecord)` | Advance the sync token after sending records |
| `setToken(subscriptionId, token)` | Set a raw token (used with `computePartialSyncToken`) |
| `initialize()` | Warm cache from a persistent `SubscriptionStore` |
