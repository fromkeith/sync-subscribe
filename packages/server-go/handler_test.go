package syncserver_test

import (
	"testing"

	synccore "github.com/sync-subscribe/core-go"
	syncserver "github.com/sync-subscribe/server-go"
)

// ---------------------------------------------------------------------------
// In-memory SyncStore for tests
// ---------------------------------------------------------------------------

type memStore struct {
	records []synccore.Record
}

func (s *memStore) GetRecordsSince(subs []syncserver.StoreSubscriptionQuery) ([]synccore.SyncPatch, error) {
	var patches []synccore.SyncPatch
	for _, sub := range subs {
		for _, r := range s.records {
			token, _ := synccore.DecodeSyncToken(sub.Since)
			if token != nil {
				if synccore.RecordInt64(r, "updatedAt") <= token.UpdatedAt {
					continue
				}
			}
			if synccore.MatchesFilter(r, sub.Filter) {
				patches = append(patches, synccore.SyncPatch{Op: "upsert", Record: r})
			}
		}
	}
	return patches, nil
}

func (s *memStore) Upsert(record synccore.Record) (synccore.Record, error) {
	id := record["recordId"].(string)
	for i, r := range s.records {
		if r["recordId"] == id {
			s.records[i] = record
			return record, nil
		}
	}
	s.records = append(s.records, record)
	return record, nil
}

func (s *memStore) GetByID(id string) (synccore.Record, error) {
	for _, r := range s.records {
		if r["recordId"] == id {
			return r, nil
		}
	}
	return nil, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newHandler() (*syncserver.SyncHandler, *memStore) {
	store := &memStore{}
	return syncserver.NewSyncHandler(store, syncserver.SyncHandlerOptions{}), store
}

func note(id, title string, rev float64) synccore.Record {
	return synccore.Record{
		"recordId":      id,
		"title":         title,
		"createdAt":     float64(1000),
		"updatedAt":     float64(2000),
		"revisionCount": rev,
	}
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

func TestPull_EmptyStore(t *testing.T) {
	h, _ := newHandler()
	resp, err := h.Pull([]syncserver.SyncSubscriptionRequest{
		{Key: "k1", Filter: synccore.SubscriptionFilter{}, SyncToken: synccore.EmptySyncToken},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Patches) != 0 {
		t.Errorf("expected 0 patches, got %d", len(resp.Patches))
	}
	if resp.SyncTokens["k1"] != synccore.EmptySyncToken {
		t.Errorf("expected empty token, got %q", resp.SyncTokens["k1"])
	}
}

func TestPull_ReturnsMatchingRecords(t *testing.T) {
	h, store := newHandler()
	store.records = []synccore.Record{note("n1", "hello", 1), note("n2", "world", 1)}

	resp, err := h.Pull([]syncserver.SyncSubscriptionRequest{
		{Key: "k1", Filter: synccore.SubscriptionFilter{"title": "hello"}, SyncToken: synccore.EmptySyncToken},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Patches) != 1 {
		t.Fatalf("expected 1 patch, got %d", len(resp.Patches))
	}
	if resp.Patches[0].Record["recordId"] != "n1" {
		t.Errorf("unexpected record: %v", resp.Patches[0].Record)
	}
}

func TestPull_DeduplicatesAcrossSubscriptions(t *testing.T) {
	h, store := newHandler()
	store.records = []synccore.Record{note("n1", "hello", 1)}

	resp, err := h.Pull([]syncserver.SyncSubscriptionRequest{
		{Key: "k1", Filter: synccore.SubscriptionFilter{}, SyncToken: synccore.EmptySyncToken},
		{Key: "k2", Filter: synccore.SubscriptionFilter{}, SyncToken: synccore.EmptySyncToken},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Patches) != 1 {
		t.Errorf("expected 1 deduplicated patch, got %d", len(resp.Patches))
	}
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

func TestPush_InsertsNewRecord(t *testing.T) {
	h, store := newHandler()
	resp, err := h.Push(synccore.PushRequest{Records: []synccore.Record{note("n1", "hello", 1)}})
	if err != nil {
		t.Fatal(err)
	}
	if !resp.OK {
		t.Error("expected ok=true")
	}
	if len(store.records) != 1 {
		t.Errorf("expected 1 stored record, got %d", len(store.records))
	}
}

func TestPush_ServerWinsConflict(t *testing.T) {
	h, store := newHandler()
	serverRecord := note("n1", "server-title", 5)
	serverRecord["updatedAt"] = float64(1000)
	store.records = []synccore.Record{serverRecord}

	clientRecord := note("n1", "client-title", 1)
	clientRecord["updatedAt"] = float64(2000)

	resp, err := h.Push(synccore.PushRequest{Records: []synccore.Record{clientRecord}})
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Conflict {
		t.Error("expected conflict=true")
	}
	if resp.ServerRecord["title"] != "server-title" {
		t.Errorf("expected server record, got %v", resp.ServerRecord)
	}
}

func TestPush_ClientWinsConflict(t *testing.T) {
	h, store := newHandler()
	serverRecord := note("n1", "server-title", 1)
	serverRecord["updatedAt"] = float64(2000)
	store.records = []synccore.Record{serverRecord}

	clientRecord := note("n1", "client-title", 2)
	clientRecord["updatedAt"] = float64(3000)

	resp, err := h.Push(synccore.PushRequest{Records: []synccore.Record{clientRecord}})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Conflict {
		t.Error("expected no conflict")
	}
	if store.records[0]["title"] != "client-title" {
		t.Errorf("expected client record to be stored, got %v", store.records[0])
	}
}

func TestPush_ReadonlyFieldsPreserved(t *testing.T) {
	store := &memStore{}
	h := syncserver.NewSyncHandler(store, syncserver.SyncHandlerOptions{
		ReadonlyFields: []string{"ownerId"},
	})

	existing := note("n1", "hello", 1)
	existing["ownerId"] = "user-123"
	store.records = []synccore.Record{existing}

	incoming := note("n1", "updated", 2)
	incoming["ownerId"] = "hacker"

	resp, err := h.Push(synccore.PushRequest{Records: []synccore.Record{incoming}})
	if err != nil {
		t.Fatal(err)
	}
	if !resp.OK {
		t.Fatal("expected ok=true")
	}
	if store.records[0]["ownerId"] != "user-123" {
		t.Errorf("readonly field was overwritten: got %v", store.records[0]["ownerId"])
	}
}

func TestPush_OnRecordsChangedCalled(t *testing.T) {
	store := &memStore{}
	var called []synccore.Record
	h := syncserver.NewSyncHandler(store, syncserver.SyncHandlerOptions{
		OnRecordsChanged: func(records []synccore.Record) { called = records },
	})

	h.Push(synccore.PushRequest{Records: []synccore.Record{note("n1", "hello", 1)}})

	if len(called) != 1 {
		t.Errorf("expected onRecordsChanged called with 1 record, got %d", len(called))
	}
}

// ---------------------------------------------------------------------------
// ServerUpsert
// ---------------------------------------------------------------------------

func TestServerUpsert_PreservesRevisionCount(t *testing.T) {
	h, store := newHandler()
	store.records = []synccore.Record{note("n1", "old", 3)}

	saved, err := h.ServerUpsert(note("n1", "new", 7))
	if err != nil {
		t.Fatal(err)
	}
	if synccore.RecordInt64(saved, "revisionCount") != 7 {
		t.Errorf("expected revisionCount=7 (caller's value), got %v", saved["revisionCount"])
	}
}

func TestServerUpsert_NoConflictResolution(t *testing.T) {
	h, store := newHandler()
	store.records = []synccore.Record{note("n1", "existing", 99)}

	saved, err := h.ServerUpsert(note("n1", "forced", 1))
	if err != nil {
		t.Fatal(err)
	}
	if saved["title"] != "forced" {
		t.Errorf("expected title=forced, got %v", saved["title"])
	}
}
