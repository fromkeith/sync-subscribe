package synccore

// ResolveConflict determines which of two records wins.
//
// Rules:
//  1. Higher revisionCount wins.
//  2. On tie, the record with the older updatedAt wins (earlier writer wins).
//
// Returns "a" if a wins, "b" if b wins.
// The sync infrastructure never modifies revisionCount — it only picks a winner.
func ResolveConflict(a, b Record) string {
	aRev := RecordInt64(a, "revisionCount")
	bRev := RecordInt64(b, "revisionCount")
	if aRev != bRev {
		if aRev > bRev {
			return "a"
		}
		return "b"
	}
	if RecordInt64(a, "updatedAt") <= RecordInt64(b, "updatedAt") {
		return "a"
	}
	return "b"
}
