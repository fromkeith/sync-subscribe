import type { SyncRecord } from "./types.js";

/**
 * Determines which of two records wins a conflict.
 *
 * Rules (from AIM.md):
 *  1. Higher revisionCount wins.
 *  2. On tie, the record with the *older* updatedAt wins (earlier writer wins).
 *
 * Returns "a" if `a` wins, "b" if `b` wins.
 */
export function resolveConflict<T extends SyncRecord>(a: T, b: T): "a" | "b" {
  if (a.revisionCount !== b.revisionCount) {
    return a.revisionCount > b.revisionCount ? "a" : "b";
  }
  // Tie-break: older updatedAt wins.
  return a.updatedAt <= b.updatedAt ? "a" : "b";
}
