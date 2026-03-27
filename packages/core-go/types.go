// Package synccore contains the types, conflict resolution, token encoding,
// and filter matching shared between sync-subscribe servers and clients.
package synccore

// Record is an arbitrary JSON object that must contain the base sync fields:
//
//	recordId       string
//	createdAt      number  (unix ms)
//	updatedAt      number  (unix ms)
//	revisionCount  number
//
// JSON numbers unmarshal to float64 in Go; use RecordString / RecordInt64 to
// read fields without type-asserting at every call site.
type Record = map[string]any

// SyncToken is an opaque base64-encoded string encoding the last sync position
// for a subscription. Clients treat it as a black box.
type SyncToken = string

// EmptySyncToken is the sentinel for a client that has never synced.
const EmptySyncToken SyncToken = ""

// SubscriptionFilter is a MongoDB-style query filter (map of field conditions).
// Supports: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or $nor $not
type SubscriptionFilter = map[string]any

// SyncPatch is a patch sent from server → client describing a single record change.
type SyncPatch struct {
	Op       string `json:"op"`                 // "upsert" or "delete"
	Record   Record `json:"record,omitempty"`   // set when Op == "upsert"
	RecordID string `json:"recordId,omitempty"` // set when Op == "delete"
}

// SubscriptionEntry is one subscription within a PullRequest or StreamRequest.
type SubscriptionEntry struct {
	Key       string             `json:"key"`
	Filter    SubscriptionFilter `json:"filter"`
	SyncToken SyncToken          `json:"syncToken"`
}

// PullRequest is the HTTP request body for the pull endpoint.
type PullRequest struct {
	Subscriptions []SubscriptionEntry `json:"subscriptions"`
}

// PullResponse is the HTTP response body for the pull endpoint.
type PullResponse struct {
	Patches    []SyncPatch          `json:"patches"`
	SyncTokens map[string]SyncToken `json:"syncTokens"`
}

// PushRequest is the HTTP request body for the push endpoint.
type PushRequest struct {
	Records []Record `json:"records"`
}

// PushResponse is the HTTP response body for the push endpoint.
// Exactly one of OK or Conflict will be true.
type PushResponse struct {
	OK              bool   `json:"ok,omitempty"`
	ServerUpdatedAt int64  `json:"serverUpdatedAt,omitempty"`
	Conflict        bool   `json:"conflict,omitempty"`
	ServerRecord    Record `json:"serverRecord,omitempty"`
}

// StreamRequest is the body for opening an SSE stream connection.
type StreamRequest struct {
	Subscriptions []SubscriptionEntry `json:"subscriptions"`
}

// StreamEvent is one SSE event emitted on the stream endpoint.
type StreamEvent struct {
	Patches    []SyncPatch          `json:"patches"`
	SyncTokens map[string]SyncToken `json:"syncTokens"`
}
