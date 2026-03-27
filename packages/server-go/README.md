# server-go

Go server handler for `sync-subscribe`. Framework-agnostic — wire `SyncHandler.Pull`, `SyncHandler.Push`, and `SyncHandler.ServerUpsert` into any HTTP framework (net/http, chi, gin, echo, …).

The server is **stateless with respect to subscriptions**. Clients send their filters and sync tokens on every request. The server never stores subscription state.

## Import

```go
import syncserver "github.com/fromkeith/sync-subscribe/packages/server-go"
```

```bash
go get github.com/fromkeith/sync-subscribe/packages/server-go@latest
```

## Quick start

### 1. Implement `SyncStore`

```go
import (
    synccore   "github.com/fromkeith/sync-subscribe/packages/core-go"
    syncserver "github.com/fromkeith/sync-subscribe/packages/server-go"
)

type NotesStore struct{ db *sql.DB }

func (s *NotesStore) GetRecordsSince(
    subs []syncserver.StoreSubscriptionQuery,
) ([]synccore.SyncPatch, error) {
    // Query your DB using each sub's Filter and Since token.
    // Results must be ordered by (updatedAt, revisionCount, recordId) ASC.
    // SyncHandler deduplicates records that match multiple subscriptions.
}

func (s *NotesStore) Upsert(record synccore.Record) (synccore.Record, error) {
    // INSERT OR REPLACE / ON CONFLICT DO UPDATE
    return record, nil
}

func (s *NotesStore) GetByID(id string) (synccore.Record, error) {
    // Return record or nil
}
```

### 2. Create a handler

```go
handler := syncserver.NewSyncHandler(&NotesStore{db: db}, syncserver.SyncHandlerOptions{
    ReadonlyFields:   []string{"createdAt", "userId"},
    OnRecordsChanged: func(records []synccore.Record) {
        // fan out to SSE connections here
    },
})
```

### 3. Wire into HTTP routes

```go
// POST /sync/pull
func pullHandler(w http.ResponseWriter, r *http.Request) {
    var body struct {
        Subscriptions []syncserver.SyncSubscriptionRequest `json:"subscriptions"`
    }
    json.NewDecoder(r.Body).Decode(&body)

    // Merge server-enforced fields into every filter (never trust the client)
    userID := userIDFromRequest(r)
    for i := range body.Subscriptions {
        body.Subscriptions[i].Filter["userId"] = userID
    }

    result, err := handler.Pull(body.Subscriptions)
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(result) // { patches, syncTokens }
}

// POST /sync/push
func pushHandler(w http.ResponseWriter, r *http.Request) {
    var body synccore.PushRequest
    json.NewDecoder(r.Body).Decode(&body)

    // Inject server-authoritative fields
    for i := range body.Records {
        body.Records[i]["userId"] = userIDFromRequest(r)
    }

    result, err := handler.Push(body)
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(result) // { ok, serverUpdatedAt } or { conflict, serverRecord }
}
```

## SSE streaming

```go
type sseConn struct {
    subscriptions []syncserver.SyncSubscriptionRequest
    w             http.ResponseWriter
    flusher       http.Flusher
}

var (
    mu          sync.Mutex
    connections = map[*sseConn]struct{}{}
)

// In OnRecordsChanged, fan out to active connections:
handler := syncserver.NewSyncHandler(store, syncserver.SyncHandlerOptions{
    OnRecordsChanged: func(records []synccore.Record) {
        mu.Lock()
        defer mu.Unlock()
        for conn := range connections {
            var patches []synccore.SyncPatch
            syncTokens := map[string]synccore.SyncToken{}
            for _, sub := range conn.subscriptions {
                for _, r := range records {
                    if synccore.MatchesFilter(r, sub.Filter) {
                        patches = append(patches, synccore.SyncPatch{Op: "upsert", Record: r})
                        syncTokens[sub.Key] = synccore.EncodeSyncToken(synccore.TokenPayload{
                            UpdatedAt:     synccore.RecordInt64(r, "updatedAt"),
                            RevisionCount: synccore.RecordInt64(r, "revisionCount"),
                            RecordID:      synccore.RecordString(r, "recordId"),
                        })
                    }
                }
            }
            if len(patches) > 0 {
                data, _ := json.Marshal(map[string]any{"patches": patches, "syncTokens": syncTokens})
                fmt.Fprintf(conn.w, "data: %s\n\n", data)
                conn.flusher.Flush()
            }
        }
    },
})

// POST /sync/stream
func streamHandler(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming not supported", 500)
        return
    }

    var body struct {
        Subscriptions []syncserver.SyncSubscriptionRequest `json:"subscriptions"`
    }
    json.NewDecoder(r.Body).Decode(&body)
    for i := range body.Subscriptions {
        body.Subscriptions[i].Filter["userId"] = userIDFromRequest(r)
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    // Send initial batch
    initial, _ := handler.Pull(body.Subscriptions)
    data, _ := json.Marshal(initial)
    fmt.Fprintf(w, "data: %s\n\n", data)
    flusher.Flush()

    conn := &sseConn{subscriptions: body.Subscriptions, w: w, flusher: flusher}
    mu.Lock()
    connections[conn] = struct{}{}
    mu.Unlock()

    <-r.Context().Done()
    mu.Lock()
    delete(connections, conn)
    mu.Unlock()
}
```

## API

### `NewSyncHandler(store SyncStore, opts SyncHandlerOptions) *SyncHandler`

### `SyncHandler` methods

| Method | Description |
|---|---|
| `Pull(subscriptions []SyncSubscriptionRequest) (*PullResponse, error)` | Return deduplicated patches + per-key sync tokens |
| `Push(req PushRequest) (*PushResponse, error)` | Accept client records; resolve conflicts; call `OnRecordsChanged` |
| `ServerUpsert(record Record) (Record, error)` | Write a record server-side; no conflict resolution; calls `OnRecordsChanged` |

### `SyncHandlerOptions`

| Field | Type | Description |
|---|---|---|
| `ReadonlyFields` | `[]string` | Fields clients cannot overwrite; server values are copied before conflict resolution |
| `OnRecordsChanged` | `func([]Record)` | Called after every successful push or server upsert; use for SSE fan-out |

### `SyncStore` interface

| Method | Description |
|---|---|
| `GetRecordsSince([]StoreSubscriptionQuery) ([]SyncPatch, error)` | Fetch records matching subscription filters since their tokens; ordered by `(updatedAt, revisionCount, recordId) ASC` |
| `Upsert(Record) (Record, error)` | Write a record; return stored copy |
| `GetByID(string) (Record, error)` | Return record by `recordId`, or `(nil, nil)` if missing |

## Local development (monorepo)

The repository root contains a `go.work` file that resolves this module and its `core-go` dependency locally — no extra setup needed:

```bash
git clone https://github.com/fromkeith/sync-subscribe
cd sync-subscribe
go test ./packages/server-go/...
```
