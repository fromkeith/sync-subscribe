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

The transport sends `X-User-Id: user-123` on every request (see `src/transport.ts`). The server merges `{ userId }` into every subscription filter at request time — the client never sees this addition and cannot bypass it. In a real app you would derive `userId` from a verified auth token.

### Subscription-driven sync

The client maintains two named subscriptions:

| Name | Filter |
|---|---|
| `recent-notes` | `{ createdAt: { $gte: <cutoff> } }` |
| `blue-notes` | `{ color: "blue" }` |

Both share a single `IdbLocalStore` — overlapping records are stored once and deduplicated client-side.

### Dynamic time range (Recent tab)

Selecting a time range on the **Recent** tab calls `updateSubscription` with the new filter. The client runs gap and eviction analysis locally: it determines whether any records matching the new filter are not yet cached, fetches only what's missing, and evicts records that only the old filter needed.

### Real-time streaming

After the initial pull, the client opens a single SSE connection (via `POST /api/sync/stream`), sending its subscription filters and sync tokens in the request body. Any push from any client triggers the `onRecordsChanged` callback on the server, which fans out the changed records to every open SSE connection whose filters match.

### Optimistic mutations

`mutate()` writes the record to IndexedDB and emits a patch event immediately (so the UI updates without waiting for the server), then pushes to the server in the background. On conflict, the server version wins and the local copy is corrected.

## Database

The server uses a SQLite file (`notes.db`) via `better-sqlite3`. On first startup, if the `notes` table is empty, it seeds **5 000 random notes** spread across the last 90 days, assigned to `user-123` (~80%) and `user-456` (~20%).

To reset the database, delete the file and restart the server:

```bash
rm examples/notes-server/notes.db
```
