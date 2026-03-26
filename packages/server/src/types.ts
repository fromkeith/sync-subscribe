import type {
  ConflictResult,
  SyncPatch,
  SyncRecord,
  SyncToken,
  SubscriptionFilter,
} from "@sync-subscribe/core";

// Re-export protocol types from core so server code can reference them directly.
export type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  StreamEvent,
  StreamRequest,
} from "@sync-subscribe/core";

export interface SyncHandlerOptions<T extends SyncRecord> {
  /**
   * Fields that clients cannot modify. For existing records, these values
   * are copied from the server record before conflict resolution and storage,
   * so client-supplied values are silently ignored.
   */
  readonlyFields?: readonly string[];
  /**
   * Called with every record successfully written to the store after a push.
   * Use this to notify SSE subscribers, invalidate caches, etc.
   */
  onRecordsChanged?: (records: T[]) => void;
}

/**
 * One entry in a pull or stream request.
 * key is an opaque client-assigned identifier echoed back in the syncTokens response.
 * filter has already had server-side additions merged in by the route handler.
 */
export interface SyncSubscriptionRequest {
  key: string;
  filter: SubscriptionFilter;
  syncToken: SyncToken;
}

/**
 * Interface that a server adapter must implement to persist and query records.
 * Framework-agnostic; implementors plug in their own storage layer.
 */
export interface SyncStore<T extends SyncRecord> {
  /**
   * Fetch records matching one or more subscription requests, each with its own
   * since-token. Implementations should query using a union of all filters
   * and return patches ordered by (updatedAt, revisionCount, recordId) ascending.
   * Deduplication across subscriptions is handled by SyncHandler.
   */
  getRecordsSince(
    subscriptions: { filter: SubscriptionFilter; since: SyncToken }[],
  ): Promise<SyncPatch<T>[]>;

  /** Write a record. Returns the stored record. */
  upsert(record: T): Promise<T>;

  /** Returns the current server record for a given id, or null. */
  getById(recordId: string): Promise<T | null>;

  /**
   * Optional: compute a smarter sync token when a subscription filter changes,
   * avoiding a full re-sync when only a subset of the data is new to the client.
   */
  computePartialSyncToken?(
    oldFilter: SubscriptionFilter,
    newFilter: SubscriptionFilter,
    existingToken: SyncToken,
  ): Promise<SyncToken>;
}

// Keep ConflictResult available to server consumers
export type { ConflictResult };
