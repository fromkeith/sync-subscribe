# core-go

Go core types and utilities for `sync-subscribe`. Provides the record model, filter matching, sync token encoding/decoding, conflict resolution, and the pull/push wire types shared between client and server implementations.

## Import

```go
import synccore "github.com/fromkeith/sync-subscribe/packages/core-go"
```

```bash
go get github.com/fromkeith/sync-subscribe/packages/core-go@latest
```

## Key types

| Type | Description |
|---|---|
| `Record` | `map[string]any` — the schema-less record model |
| `SyncToken` | Opaque string encoding `updatedAt`, `revisionCount`, `recordId` — used to resume incremental pulls |
| `SubscriptionFilter` | `map[string]any` — MongoDB-style filter applied client- and server-side |
| `SyncPatch` | One change event: `{ Op: "upsert", Record }` or `{ Op: "delete", RecordID }` |
| `PullResponse` | `{ Patches []SyncPatch, SyncTokens map[string]SyncToken }` |
| `PushRequest` | `{ Records []Record }` |
| `PushResponse` | `{ OK bool, ServerUpdatedAt int64 }` or `{ Conflict bool, ServerRecord Record }` |
| `TokenPayload` | Decoded sync token: `UpdatedAt`, `RevisionCount`, `RecordID` |

## Core functions

```go
// Sync tokens
token := synccore.EncodeSyncToken(synccore.TokenPayload{
    UpdatedAt:     record["updatedAt"].(int64),
    RevisionCount: record["revisionCount"].(int64),
    RecordID:      record["recordId"].(string),
})

payload, err := synccore.DecodeSyncToken(token)

// Filter matching
matched := synccore.MatchesFilter(record, filter)

// Conflict resolution — returns "a" if record a wins, "b" if record b wins
winner := synccore.ResolveConflict(incoming, existing) // "a" or "b"

// Safe field access helpers
id    := synccore.RecordString(record, "recordId")
ts    := synccore.RecordInt64(record, "updatedAt")

// Record manipulation
copy := synccore.CopyRecord(record)
```

## Supported filter operators

`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$or`, `$and`, `$nor`

```go
filter := synccore.SubscriptionFilter{
    "userId":    "user-123",
    "updatedAt": map[string]any{"$gte": float64(sinceMs)},
    "isDeleted": false,
}
matched := synccore.MatchesFilter(record, filter)
```

## Local development (monorepo)

The repository root contains a `go.work` file that resolves this module locally — no extra setup needed when working inside the monorepo:

```bash
git clone https://github.com/fromkeith/sync-subscribe
cd sync-subscribe
go test ./packages/core-go/...
```
