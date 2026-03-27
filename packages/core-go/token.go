package synccore

import (
	"encoding/base64"
	"encoding/json"
)

// TokenPayload is the decoded contents of a SyncToken.
type TokenPayload struct {
	UpdatedAt     int64  `json:"updatedAt"`
	RevisionCount int64  `json:"revisionCount"`
	RecordID      string `json:"recordId"`
}

// EncodeSyncToken encodes a token payload to an opaque base64 string.
// Format: base64(JSON({updatedAt, revisionCount, recordId}))
// Uses standard base64 to match browser btoa() behaviour.
func EncodeSyncToken(p TokenPayload) SyncToken {
	data, _ := json.Marshal(p)
	return base64.StdEncoding.EncodeToString(data)
}

// DecodeSyncToken decodes a sync token. Returns (nil, nil) for an empty token,
// and a non-nil error for a malformed one.
// Tries standard base64 first (browser btoa), then URL-safe (Node.js Buffer).
func DecodeSyncToken(token SyncToken) (*TokenPayload, error) {
	if token == "" {
		return nil, nil
	}
	data, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		data, err = base64.URLEncoding.DecodeString(token)
		if err != nil {
			return nil, err
		}
	}
	var p TokenPayload
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	return &p, nil
}
