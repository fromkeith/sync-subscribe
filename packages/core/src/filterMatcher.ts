import type {
  FilterCondition,
  FilterValue,
  SubscriptionFilter,
} from "./types.js";

export interface FilterDiff {
  /** Conditions present in newFilter but absent from oldFilter. */
  added: SubscriptionFilter;
  /** Conditions present in oldFilter but absent from newFilter. */
  removed: SubscriptionFilter;
  /** Conditions present in both filters but with different values. */
  changed: Record<string, { from: FilterCondition; to: FilterCondition }>;
  /** True when added, removed, and changed are all empty. */
  unchanged: boolean;
}

/**
 * Computes the diff between two subscription filters.
 *
 * Useful when a subscription is updated — the result tells you which parts of
 * the filter are new (potentially requiring a partial re-sync) and which parts
 * were removed (potentially requiring client-side eviction).
 */
export function filterDiff(
  oldFilter: SubscriptionFilter,
  newFilter: SubscriptionFilter,
): FilterDiff {
  const added: SubscriptionFilter = {};
  const removed: SubscriptionFilter = {};
  const changed: Record<string, { from: FilterCondition; to: FilterCondition }> = {};

  const allKeys = new Set([...Object.keys(oldFilter), ...Object.keys(newFilter)]);

  for (const key of allKeys) {
    const inOld = key in oldFilter;
    const inNew = key in newFilter;

    if (inNew && !inOld) {
      added[key] = newFilter[key]!;
    } else if (inOld && !inNew) {
      removed[key] = oldFilter[key]!;
    } else if (JSON.stringify(oldFilter[key]) !== JSON.stringify(newFilter[key])) {
      changed[key] = { from: oldFilter[key]!, to: newFilter[key]! };
    }
  }

  return {
    added,
    removed,
    changed,
    unchanged:
      Object.keys(added).length === 0 &&
      Object.keys(removed).length === 0 &&
      Object.keys(changed).length === 0,
  };
}

/** If 2 filtesr are equal */
export function filtersEqual(
  a: SubscriptionFilter,
  b: SubscriptionFilter,
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length || keysA.join() !== keysB.join())
    return false;
  return keysA.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * Evaluates whether a record satisfies all conditions in a SubscriptionFilter.
 * Used on both client (eviction) and server (subscription fan-out).
 */
export function matchesFilter(
  record: Record<string, unknown>,
  filter: SubscriptionFilter,
): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (!matchesCondition(record[key], condition)) return false;
  }
  return true;
}

function matchesCondition(value: unknown, condition: FilterCondition): boolean {
  // Equality / primitive check
  if (condition === null || typeof condition !== "object") {
    return value === condition;
  }

  // Operator check — null/undefined values never satisfy ordering operators
  const v = value as FilterValue;
  if (v === null || v === undefined) {
    return "$ne" in condition; // only $ne makes sense against null
  }

  if ("$gt" in condition) {
    return condition.$gt !== null && v > condition.$gt;
  }
  if ("$gte" in condition) {
    return condition.$gte !== null && v >= condition.$gte;
  }
  if ("$lt" in condition) {
    return condition.$lt !== null && v < condition.$lt;
  }
  if ("$lte" in condition) {
    return condition.$lte !== null && v <= condition.$lte;
  }
  if ("$ne" in condition) {
    return v !== condition.$ne;
  }

  return false;
}
