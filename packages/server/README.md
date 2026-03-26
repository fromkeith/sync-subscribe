# @sync-subscribe/server

Framework-agnostic sync server for `sync-subscribe`. Wire `SyncHandler` into any HTTP framework (Express, Hono, Fastify, …) to expose pull, push, and SSE streaming endpoints.

## Design

The server is **stateless with respect to subscriptions**. Clients send their filters and sync tokens directly in every pull/stream request — the server never stores subscription state. This means:

- No subscription table in your database
- No risk of client/server subscription desync
- The server simply applies its own mandatory filter additions (e.g. `userId`) at request time

## Concepts

| Term | Description |
|---|---|
| `SyncRecord` | Every synced record must have `recordId`, `createdAt`, `updatedAt`, `revisionCount` |
| `SyncStore` | Your storage adapter — implement `getRecordsSince`, `upsert`, `getById` |
| `SyncHandler` | Orchestrates pull / push logic; decoupled from HTTP |
| `SyncSubscriptionRequest` | One entry in a pull/stream request: `{ key, filter, syncToken }` |
| Server filter additions | Fields the server merges into every client filter (e.g. `userId`) — invisible to the client |

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
    subscriptions: { filter: SubscriptionFilter; since: SyncToken }[]
  ): Promise<SyncPatch<NoteRecord>[]> {
    // Query your DB using a union of all subscription filters,
    // each scoped to its own since-token.
    // Results must be ordered by (updatedAt ASC, revisionCount ASC, recordId ASC).
    // SyncHandler deduplicates records that match multiple subscriptions.
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
import { SyncHandler } from "@sync-subscribe/server";
import type { SyncSubscriptionRequest } from "@sync-subscribe/server";
import type { SubscriptionFilter } from "@sync-subscribe/core";

const store = new NotesStore();
const handler = new SyncHandler<NoteRecord>(store, {
  readonlyFields: ["createdAt"],          // clients cannot overwrite these
  onRecordsChanged: (records) => { /* notify SSE clients */ },
});

// POST /sync/pull — pull patches for all requested subscriptions
app.post("/sync/pull", async (req, res) => {
  const { subscriptions } = req.body as { subscriptions: SyncSubscriptionRequest[] };

  // Merge server-enforced fields into each subscription's filter.
  // The client never sees these additions.
  const merged = subscriptions.map((s) => ({
    ...s,
    filter: { ...s.filter, userId: req.user.id } as SubscriptionFilter,
  }));

  const result = await handler.pull(merged);
  res.json(result); // { patches, syncTokens }
});

// POST /sync/push — push records from client
app.post("/sync/push", async (req, res) => {
  const { records } = req.body;
  // Inject server-authoritative fields before processing
  const sanitized = records.map((r) => ({ ...r, userId: req.user.id }));
  const result = await handler.push({ records: sanitized });
  res.json(result); // { ok: true, serverUpdatedAt } or { conflict: true, serverRecord }
});
```

## SSE streaming

The client opens a persistent SSE stream by POSTing its subscriptions (same shape as pull). The server sends an initial batch, then fans out future changes via `onRecordsChanged`.

```ts
import { matchesFilter, encodeSyncToken } from "@sync-subscribe/core";
import type { SyncToken, SubscriptionFilter, StreamEvent } from "@sync-subscribe/core";

interface SseConnection {
  subscriptions: { key: string; filter: SubscriptionFilter }[];
  res: Response;
}
const sseConnections = new Set<SseConnection>();

const handler = new SyncHandler<NoteRecord>(store, {
  onRecordsChanged: (records) => {
    for (const conn of sseConnections) {
      const patches = [];
      const syncTokens: Record<string, SyncToken> = {};

      for (const sub of conn.subscriptions) {
        const matching = records.filter((r) =>
          matchesFilter(r as Record<string, unknown>, sub.filter)
        );
        if (matching.length === 0) continue;

        const last = matching[matching.length - 1]!;
        syncTokens[sub.key] = encodeSyncToken({
          updatedAt: last.updatedAt,
          revisionCount: last.revisionCount,
          recordId: last.recordId,
        });
        patches.push(...matching.map((r) => ({ op: "upsert" as const, record: r })));
      }

      if (patches.length > 0) {
        conn.res.write(`data: ${JSON.stringify({ patches, syncTokens })}\n\n`);
      }
    }
  },
});

// POST /sync/stream — POST-based SSE (body carries subscriptions)
app.post("/sync/stream", async (req, res) => {
  const { subscriptions } = req.body as { subscriptions: SyncSubscriptionRequest[] };

  // Merge server filter additions
  const merged = subscriptions.map((s) => ({
    ...s,
    filter: { ...s.filter, userId: req.user.id } as SubscriptionFilter,
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send initial batch
  const initial = await handler.pull(merged);
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  // Register for future push notifications
  const conn: SseConnection = {
    subscriptions: merged.map((s) => ({ key: s.key, filter: s.filter })),
    res,
  };
  sseConnections.add(conn);

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseConnections.delete(conn);
  });
});
```

## Server-initiated writes

Use `serverUpsert` for background jobs, webhooks, or inter-service writes. Unlike `push`, there is no conflict resolution — the server's intent always wins.

```ts
await handler.serverUpsert({
  recordId: "note-abc",
  userId: "system",
  title: "Auto-generated",
  contents: "...",
  isDeleted: false,
  createdAt: 0,       // overwritten by serverUpsert
  updatedAt: 0,       // overwritten by serverUpsert
  revisionCount: 0,   // incremented by serverUpsert
});
```

`onRecordsChanged` fires after every `serverUpsert`, so SSE clients are notified automatically.

## Readonly fields

Fields listed in `readonlyFields` are copied from the existing server record before conflict resolution. Clients cannot overwrite them even if they try.

```ts
new SyncHandler(store, {
  readonlyFields: ["createdAt", "userId"],
});
```

## Conflict resolution

On `push`, if the server's `revisionCount` is higher than the incoming record (or equal with an older `updatedAt`), the push returns a conflict:

```ts
// { conflict: true, serverRecord: NoteRecord }
```

The client should apply the server record locally and retry if needed. `revisionCount` acts as a "work done" counter — it doesn't depend on clocks.

## API reference

### `SyncHandler<T>`

| Method | Description |
|---|---|
| `pull(subscriptions)` | Return deduplicated patches and per-key `syncTokens` for all requested subscriptions |
| `push(req)` | Accept client records, resolve conflicts, persist, fire `onRecordsChanged` |
| `serverUpsert(record)` | Write a record as the server; no conflict resolution; fires `onRecordsChanged` |

### `SyncHandlerOptions<T>`

| Option | Description |
|---|---|
| `readonlyFields` | Fields clients cannot modify |
| `onRecordsChanged` | Called after every successful `push` or `serverUpsert` with the stored records |

### `SyncStore<T>`

| Method | Description |
|---|---|
| `getRecordsSince(subscriptions)` | Fetch records matching a union of `{ filter, since }` entries; ordered by `(updatedAt, revisionCount, recordId) ASC` |
| `upsert(record)` | Write a record; return the stored record |
| `getById(recordId)` | Return the current record for a given id, or `null` |
| `computePartialSyncToken?(oldFilter, newFilter, token)` | Optional: compute a smarter token when a subscription filter changes |
