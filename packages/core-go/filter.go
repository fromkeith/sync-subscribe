package synccore

import (
	"reflect"
	"regexp"
	"strings"
)

// MatchesFilter returns true if record satisfies every condition in filter.
//
// Supported operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex
// $and $or $nor $not
func MatchesFilter(record Record, filter SubscriptionFilter) bool {
	return evalFilter(record, filter)
}

func evalFilter(record map[string]any, filter map[string]any) bool {
	for key, val := range filter {
		switch key {
		case "$and":
			for _, c := range asClauses(val) {
				if !evalFilter(record, c) {
					return false
				}
			}
		case "$or":
			clauses := asClauses(val)
			if len(clauses) == 0 {
				return false // $or:[] is always-false
			}
			matched := false
			for _, c := range clauses {
				if evalFilter(record, c) {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
		case "$nor":
			for _, c := range asClauses(val) {
				if evalFilter(record, c) {
					return false
				}
			}
		default:
			if !evalCondition(record[key], val) {
				return false
			}
		}
	}
	return true
}

func evalCondition(fieldVal any, condition any) bool {
	condMap, isMap := condition.(map[string]any)
	if !isMap {
		return numericOrDeepEqual(fieldVal, condition)
	}
	for k := range condMap {
		if strings.HasPrefix(k, "$") {
			return evalOperators(fieldVal, condMap)
		}
	}
	return numericOrDeepEqual(fieldVal, condition)
}

func evalOperators(fieldVal any, ops map[string]any) bool {
	for op, opVal := range ops {
		switch op {
		case "$eq":
			if !numericOrDeepEqual(fieldVal, opVal) {
				return false
			}
		case "$ne":
			if numericOrDeepEqual(fieldVal, opVal) {
				return false
			}
		case "$gt":
			cmp, ok := compareValues(fieldVal, opVal)
			if !ok || cmp <= 0 {
				return false
			}
		case "$gte":
			cmp, ok := compareValues(fieldVal, opVal)
			if !ok || cmp < 0 {
				return false
			}
		case "$lt":
			cmp, ok := compareValues(fieldVal, opVal)
			if !ok || cmp >= 0 {
				return false
			}
		case "$lte":
			cmp, ok := compareValues(fieldVal, opVal)
			if !ok || cmp > 0 {
				return false
			}
		case "$in":
			arr, ok := opVal.([]any)
			if !ok {
				return false
			}
			found := false
			for _, v := range arr {
				if numericOrDeepEqual(fieldVal, v) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		case "$nin":
			arr, ok := opVal.([]any)
			if !ok {
				return false
			}
			for _, v := range arr {
				if numericOrDeepEqual(fieldVal, v) {
					return false
				}
			}
		case "$exists":
			want, ok := opVal.(bool)
			if !ok {
				return false
			}
			if want != (fieldVal != nil) {
				return false
			}
		case "$regex":
			s, ok := fieldVal.(string)
			if !ok {
				return false
			}
			pattern, ok := opVal.(string)
			if !ok {
				return false
			}
			matched, err := regexp.MatchString(pattern, s)
			if err != nil || !matched {
				return false
			}
		case "$not":
			notCond, ok := opVal.(map[string]any)
			if !ok {
				return false
			}
			if evalCondition(fieldVal, notCond) {
				return false
			}
		}
	}
	return true
}

func compareValues(a, b any) (int, bool) {
	af, aok := toFloat64(a)
	bf, bok := toFloat64(b)
	if aok && bok {
		switch {
		case af < bf:
			return -1, true
		case af > bf:
			return 1, true
		default:
			return 0, true
		}
	}
	as, asok := a.(string)
	bs, bsok := b.(string)
	if asok && bsok {
		return strings.Compare(as, bs), true
	}
	return 0, false
}

func numericOrDeepEqual(a, b any) bool {
	if reflect.DeepEqual(a, b) {
		return true
	}
	af, aok := toFloat64(a)
	bf, bok := toFloat64(b)
	if aok && bok {
		return af == bf
	}
	return false
}

func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func asClauses(v any) []map[string]any {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(arr))
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
