package syncserver

import (
	"time"

	synccore "github.com/sync-subscribe/core-go"
)

// SyncHandler implements the core pull/push logic, decoupled from any HTTP
// framework. Wire its methods into your route handlers.
//
// The server has no concept of stored subscriptions. The client sends its
// filters and sync tokens directly in every request. The route handler is
// responsible for merging server-side filter additions (e.g. userId from auth
// context) before calling Pull.
type SyncHandler struct {
	store   SyncStore
	options SyncHandlerOptions
}

// NewSyncHandler creates a SyncHandler backed by the given store.
func NewSyncHandler(store SyncStore, opts SyncHandlerOptions) *SyncHandler {
	return &SyncHandler{store: store, options: opts}
}

// Pull returns deduplicated patches and one updated sync token per subscription.
func (h *SyncHandler) Pull(subscriptions []SyncSubscriptionRequest) (*synccore.PullResponse, error) {
	queries := make([]StoreSubscriptionQuery, len(subscriptions))
	for i, s := range subscriptions {
		queries[i] = StoreSubscriptionQuery{Filter: s.Filter, Since: s.SyncToken}
	}

	allPatches, err := h.store.GetRecordsSince(queries)
	if err != nil {
		return nil, err
	}

	// Compute the latest sync token per subscription key.
	syncTokens := make(map[string]synccore.SyncToken, len(subscriptions))
	for _, sub := range subscriptions {
		var lastMatch synccore.Record
		for _, p := range allPatches {
			if p.Op == "upsert" && synccore.MatchesFilter(p.Record, sub.Filter) {
				lastMatch = p.Record
			}
		}
		if lastMatch != nil {
			syncTokens[sub.Key] = synccore.EncodeSyncToken(synccore.TokenPayload{
				UpdatedAt:     synccore.RecordInt64(lastMatch, "updatedAt"),
				RevisionCount: synccore.RecordInt64(lastMatch, "revisionCount"),
				RecordID:      synccore.RecordString(lastMatch, "recordId"),
			})
		} else {
			syncTokens[sub.Key] = sub.SyncToken
		}
	}

	// Deduplicate patches — last write per recordId wins across subscriptions.
	patchMap := make(map[string]synccore.SyncPatch, len(allPatches))
	for _, p := range allPatches {
		var key string
		if p.Op == "upsert" {
			key = synccore.RecordString(p.Record, "recordId")
		} else {
			key = p.RecordID
		}
		patchMap[key] = p
	}

	patches := make([]synccore.SyncPatch, 0, len(patchMap))
	for _, p := range patchMap {
		patches = append(patches, p)
	}

	return &synccore.PullResponse{Patches: patches, SyncTokens: syncTokens}, nil
}

// Push applies client records. Returns a conflict response if the server record
// wins conflict resolution; otherwise returns ok with the server's updatedAt.
func (h *SyncHandler) Push(req synccore.PushRequest) (*synccore.PushResponse, error) {
	now := time.Now().UnixMilli()
	var stored []synccore.Record

	for _, incoming := range req.Records {
		existing, err := h.store.GetByID(synccore.RecordString(incoming, "recordId"))
		if err != nil {
			return nil, err
		}

		record := synccore.CopyRecord(incoming)

		// Enforce readonly fields — copy server values over client's.
		if len(h.options.ReadonlyFields) > 0 && existing != nil {
			for _, field := range h.options.ReadonlyFields {
				record[field] = existing[field]
			}
		}

		if existing != nil {
			if synccore.ResolveConflict(record, existing) == "b" {
				return &synccore.PushResponse{Conflict: true, ServerRecord: existing}, nil
			}
		}

		toStore := synccore.CopyRecord(record)
		toStore["updatedAt"] = float64(now)
		if existing != nil {
			toStore["createdAt"] = existing["createdAt"]
		} else {
			toStore["createdAt"] = float64(now)
		}

		saved, err := h.store.Upsert(toStore)
		if err != nil {
			return nil, err
		}
		stored = append(stored, saved)
	}

	if len(stored) > 0 && h.options.OnRecordsChanged != nil {
		h.options.OnRecordsChanged(stored)
	}

	return &synccore.PushResponse{OK: true, ServerUpdatedAt: now}, nil
}

// ServerUpsert writes a record from a server-side process (background job,
// webhook, etc.). The server's intent always wins — no conflict resolution.
// The caller is responsible for setting revisionCount before calling this.
func (h *SyncHandler) ServerUpsert(record synccore.Record) (synccore.Record, error) {
	existing, err := h.store.GetByID(synccore.RecordString(record, "recordId"))
	if err != nil {
		return nil, err
	}

	incoming := synccore.CopyRecord(record)
	if len(h.options.ReadonlyFields) > 0 && existing != nil {
		for _, field := range h.options.ReadonlyFields {
			incoming[field] = existing[field]
		}
	}

	now := time.Now().UnixMilli()
	toStore := synccore.CopyRecord(incoming)
	toStore["updatedAt"] = float64(now)
	if existing != nil {
		toStore["createdAt"] = existing["createdAt"]
	} else {
		toStore["createdAt"] = float64(now)
	}

	saved, err := h.store.Upsert(toStore)
	if err != nil {
		return nil, err
	}

	if h.options.OnRecordsChanged != nil {
		h.options.OnRecordsChanged([]synccore.Record{saved})
	}

	return saved, nil
}
