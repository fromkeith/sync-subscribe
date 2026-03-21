import sift from "sift";
import type { SubscriptionFilter } from "./types.js";

/** Returns true if two filters are deeply equal. */
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
 * Returns true if the record satisfies every condition in the filter.
 * Delegates to sift for full MongoDB-style query support.
 */
export function matchesFilter(
  record: Record<string, unknown>,
  filter: SubscriptionFilter,
): boolean {
  return sift(filter)(record);
}

/**
 * Merges two or more filters into a single filter whose match set is the union
 * of all inputs — a record is included if it would match ANY of the inputs.
 *
 * With sift's $or operator this is a one-liner; the full query power of sift
 * is preserved inside each branch.
 *
 * @example
 * filterUnion({ color: "blue" }, { color: "red" })
 * // → { $or: [{ color: "blue" }, { color: "red" }] }
 */
export function filterUnion(
  ...filters: SubscriptionFilter[]
): SubscriptionFilter {
  if (filters.length === 0) return {};
  if (filters.length === 1) return { ...filters[0] };
  return { $or: filters };
}
