// Package syncserver provides the core sync logic for sync-subscribe servers.
// It is framework-agnostic: wire Pull, Push, and ServerUpsert into your own
// HTTP handlers (net/http, chi, gin, echo, …).
package syncserver

import synccore "github.com/fromkeith/sync-subscribe/packages/core-go"

// SyncHandlerOptions configures a SyncHandler.
type SyncHandlerOptions struct {
	// ReadonlyFields lists fields that clients cannot modify. For existing
	// records the server's stored values are copied over the client's before
	// conflict resolution.
	ReadonlyFields []string

	// OnRecordsChanged is called with every record successfully written after
	// a push or server upsert. Use it to fan out SSE events, invalidate
	// caches, etc.
	OnRecordsChanged func(records []synccore.Record)
}

// SyncSubscriptionRequest is one fully-resolved entry passed to Pull.
// The route handler is responsible for merging server-side filter additions
// (e.g. userId from auth context) before handing off to the handler.
type SyncSubscriptionRequest struct {
	Key       string
	Filter    synccore.SubscriptionFilter
	SyncToken synccore.SyncToken
}

// StoreSubscriptionQuery is one entry passed to SyncStore.GetRecordsSince.
type StoreSubscriptionQuery struct {
	Filter synccore.SubscriptionFilter
	Since  synccore.SyncToken
}

// SyncStore is the persistence interface that server adapters must implement.
type SyncStore interface {
	// GetRecordsSince fetches records matching one or more subscription queries,
	// each scoped by a since-token. Records should be ordered by
	// (updatedAt, revisionCount, recordId) ascending.
	GetRecordsSince(subscriptions []StoreSubscriptionQuery) ([]synccore.SyncPatch, error)

	// Upsert writes a record and returns the stored copy.
	Upsert(record synccore.Record) (synccore.Record, error)

	// GetByID returns the current server record for a given id, or (nil, nil)
	// if no record exists with that id.
	GetByID(recordID string) (synccore.Record, error)
}
