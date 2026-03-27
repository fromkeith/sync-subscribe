package synccore

// RecordString reads a string field from a Record.
func RecordString(r Record, key string) string {
	if v, ok := r[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// RecordInt64 reads a numeric field from a Record.
// JSON numbers unmarshal to float64 in Go, so that conversion is handled here.
func RecordInt64(r Record, key string) int64 {
	if v, ok := r[key]; ok {
		switch n := v.(type) {
		case float64:
			return int64(n)
		case int64:
			return n
		case int:
			return int64(n)
		case int32:
			return int64(n)
		}
	}
	return 0
}

// CopyRecord returns a shallow copy of a Record.
func CopyRecord(r Record) Record {
	out := make(Record, len(r))
	for k, v := range r {
		out[k] = v
	}
	return out
}
