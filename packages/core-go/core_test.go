package synccore_test

import (
	"testing"

	synccore "github.com/fromkeith/sync-subscribe/packages/core-go"
)

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

func TestTokenRoundTrip(t *testing.T) {
	p := synccore.TokenPayload{UpdatedAt: 1234567890, RevisionCount: 42, RecordID: "abc"}
	token := synccore.EncodeSyncToken(p)
	if token == "" {
		t.Fatal("expected non-empty token")
	}
	decoded, err := synccore.DecodeSyncToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.UpdatedAt != p.UpdatedAt || decoded.RevisionCount != p.RevisionCount || decoded.RecordID != p.RecordID {
		t.Errorf("round-trip mismatch: got %+v, want %+v", decoded, p)
	}
}

func TestDecodeSyncToken_Empty(t *testing.T) {
	p, err := synccore.DecodeSyncToken(synccore.EmptySyncToken)
	if err != nil || p != nil {
		t.Errorf("expected (nil, nil) for empty token, got (%v, %v)", p, err)
	}
}

// ---------------------------------------------------------------------------
// ResolveConflict
// ---------------------------------------------------------------------------

func TestResolveConflict_HigherRevWins(t *testing.T) {
	a := synccore.Record{"revisionCount": float64(5), "updatedAt": float64(2000)}
	b := synccore.Record{"revisionCount": float64(3), "updatedAt": float64(1000)}
	if synccore.ResolveConflict(a, b) != "a" {
		t.Error("expected a (higher revisionCount) to win")
	}
}

func TestResolveConflict_TieOlderUpdatedAtWins(t *testing.T) {
	a := synccore.Record{"revisionCount": float64(3), "updatedAt": float64(1000)}
	b := synccore.Record{"revisionCount": float64(3), "updatedAt": float64(2000)}
	if synccore.ResolveConflict(a, b) != "a" {
		t.Error("expected a (older updatedAt) to win on tie")
	}
}

// ---------------------------------------------------------------------------
// MatchesFilter
// ---------------------------------------------------------------------------

func TestMatchesFilter(t *testing.T) {
	r := synccore.Record{"color": "blue", "count": float64(5), "active": true}

	cases := []struct {
		filter synccore.SubscriptionFilter
		want   bool
	}{
		{synccore.SubscriptionFilter{}, true},
		{synccore.SubscriptionFilter{"color": "blue"}, true},
		{synccore.SubscriptionFilter{"color": "red"}, false},
		{synccore.SubscriptionFilter{"color": map[string]any{"$ne": "red"}}, true},
		{synccore.SubscriptionFilter{"count": map[string]any{"$gt": float64(3)}}, true},
		{synccore.SubscriptionFilter{"count": map[string]any{"$lt": float64(3)}}, false},
		{synccore.SubscriptionFilter{"count": map[string]any{"$in": []any{float64(5), float64(6)}}}, true},
		{synccore.SubscriptionFilter{"count": map[string]any{"$nin": []any{float64(5)}}}, false},
		{synccore.SubscriptionFilter{"$or": []any{map[string]any{"color": "red"}, map[string]any{"color": "blue"}}}, true},
		{synccore.SubscriptionFilter{"$or": []any{}}, false},
		{synccore.SubscriptionFilter{"$and": []any{map[string]any{"color": "blue"}, map[string]any{"active": true}}}, true},
		{synccore.SubscriptionFilter{"missing": map[string]any{"$exists": false}}, true},
		{synccore.SubscriptionFilter{"color": map[string]any{"$exists": true}}, true},
	}

	for _, tc := range cases {
		got := synccore.MatchesFilter(r, tc.filter)
		if got != tc.want {
			t.Errorf("filter %v: got %v, want %v", tc.filter, got, tc.want)
		}
	}
}
