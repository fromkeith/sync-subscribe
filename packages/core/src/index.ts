export type {
  SyncRecord,
  FilterValue,
  SubscriptionFilter,
  SyncToken,
  Subscription,
  SyncPatch,
  ConflictResult,
} from "./types.js";
export { EMPTY_SYNC_TOKEN } from "./types.js";
export { resolveConflict } from "./conflict.js";
export { encodeSyncToken, decodeSyncToken } from "./syncToken.js";
export { matchesFilter, filtersEqual, filterDiff, filterUnion } from "./filterMatcher.js";
export type { FilterDiff } from "./filterMatcher.js";
