# @sync-subscribe/core

Shared types, filter matching, and sync token utilities for `sync-subscribe`. Used internally by `@sync-subscribe/client` and `@sync-subscribe/server` — you generally don't need to install this directly unless you're building a custom transport or server adapter.

## Installation

```bash
npm install @sync-subscribe/core
```

## Key types

```ts
import type {
  SyncRecord,           // base record shape
  SubscriptionFilter,   // MongoDB-style filter
  SyncPatch,            // { op: "upsert", record } | { op: "delete", recordId }
  SyncToken,            // opaque string for incremental sync
  TableSchema,          // optional Zod schema + index hints for IdbLocalStore
} from "@sync-subscribe/core";
```

### `SyncRecord`

Every synced record must extend `SyncRecord`:

```ts
interface SyncRecord {
  recordId: string;
  createdAt: number;   // ms since epoch
  updatedAt: number;   // ms since epoch — set by the server on push
  revisionCount: number;
}
```

### `SubscriptionFilter`

MongoDB-style query object. Supported operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$or`, `$and`, `$nor`.

```ts
const filter: SubscriptionFilter = {
  userId: "user-123",
  createdAt: { $gte: Date.now() - 7 * 24 * 60 * 60 * 1000 },
  isDeleted: false,
};
```

### `TableSchema<T>`

Optional Zod schema + IDB index hints, passed to `IdbLocalStore` for validation and query performance:

```ts
import { z } from "zod";
import type { TableSchema } from "@sync-subscribe/core";

const noteSchema: TableSchema<NoteRecord> = {
  schema: z.object({ recordId: z.string(), /* … */ }),
  tableName: "notes",
  recordId: "recordId",
  indexes: [["userId"], ["isDeleted"], ["updatedAt"]],
};
```

## Utilities

```ts
import { matchesFilter, encodeSyncToken, decodeSyncToken } from "@sync-subscribe/core";

// Client-side filter evaluation
const matched = matchesFilter(record, { isDeleted: false });

// Sync tokens
const token = encodeSyncToken({ updatedAt: 1234, revisionCount: 2, recordId: "abc" });
const payload = decodeSyncToken(token); // { updatedAt, revisionCount, recordId }
```
