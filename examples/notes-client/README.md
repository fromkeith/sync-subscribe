# Notes Example

A full-stack notes app demonstrating real-time sync with `sync-subscribe`. Records are synced from a SQLite-backed Express server to a React client via server-sent events (SSE), with offline-capable IndexedDB persistence on the client.

## Structure

```
examples/
  notes-client/   React + Vite frontend
  notes-server/   Express + SQLite backend
```

## Running locally

From the repo root, install dependencies once:

```bash
pnpm install
```

Start both the server and client in separate terminals:

```bash
pnpm dev
```

Then open `http://localhost:5173`.

The Vite dev server proxies `/api` to `http://localhost:3001`, so no CORS configuration is needed during development.

## What it demonstrates

### Server-side user isolation

The transport sends `X-User-Id: user-123` on every request (see `src/transport.ts`). The server injects this as a mandatory `userId` clause on every subscription filter, so a client can never construct a filter that returns another user's notes. In the real world you would not do auth this way. But it demonstrates how the server can add its own filtering.

### Subscription-driven sync

The client maintains two named server subscriptions:

| Name | Filter |
|---|---|
| `recent-notes` | `{ createdAt: { $gte: <cutoff> } }` |
| `blue-notes` | `{ color: "blue" }` |

Both share a single `IdbLocalStore` — overlapping records are stored once and deduplicated client-side.

### Dynamic time range (Recent tab)

Selecting a time range on the **Recent** tab issues an `updateSubscription` call with `previousSubscriptionId`, so the server computes a minimal diff rather than re-sending all matching records. The gap analysis in `SyncClient` determines whether any locally-cached data already satisfies the new filter.

### Real-time streaming

After the initial pull, the client opens a single SSE connection. Any push from any client triggers an `onRecordsChanged` callback on the server, which fans out the changed records to every open SSE connection whose subscription filter matches.

### Optimistic mutations

`mutate()` writes the record to IndexedDB and emits a patch event immediately (so the UI updates without waiting for the server), then pushes to the server in the background. On conflict, the server version wins and the local copy is corrected.


## Database

The server uses a SQLite file (`notes.db`) via `better-sqlite3`. On first startup, if the `notes` table is empty, it seeds **5 000 random notes** spread across the last 90 days, assigned to `user-123` (~80%) and `user-456` (~20%).

To reset the database, delete the file and restart the server:

```bash
rm examples/notes-server/notes.db
```
