import type {
  ConflictResult,
  SyncPatch,
  SyncRecord,
  SyncToken,
  Subscription,
  SubscriptionFilter,
} from "@sync-subscribe/core";

/** A stored subscription on the server, augmented with server-side filter addons. */
export interface ServerSubscription extends Subscription {
  /** Client-supplied portion of the filter. Sent back to the client as `filter`. */
  clientFilter: SubscriptionFilter;
  /**
   * Complete effective filter used for server-side queries.
   * Includes all clientFilter fields plus any server-enforced additions (e.g. accountId).
   * clientFilter ⊆ serverFilter. Never sent to the client.
   */
  serverFilter: SubscriptionFilter;
}

export interface CreateSubscriptionResponse {
  subscriptionId: string;
  syncToken: SyncToken;
  /**
   * True when the filter changed on update and the client should evict
   * data that no longer matches the new filter, then do a full re-sync.
   * Always false for brand-new subscriptions.
   */
  resetRequired: boolean;
}

/** Request body for GET /sync (pull) */
export interface PullRequest {
  subscriptionId: string;
  syncToken: SyncToken;
}

export interface PullResponse<T extends SyncRecord> {
  patches: SyncPatch<T>[];
  syncToken: SyncToken;
}

/** Request body for POST /sync (push) */
export interface PushRequest<T extends SyncRecord> {
  subscriptionId: string;
  records: T[];
}

export type PushResponse<T extends SyncRecord> =
  | { ok: true }
  | ConflictResult<T>;

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
 * Persistence interface for server-side subscriptions.
 *
 * The default SubscriptionManager keeps subscriptions in-memory only, so they
 * are lost on server restart. Provide a SubscriptionStore implementation backed
 * by your database to survive restarts.
 *
 * Example: implement with a simple key-value table keyed on subscriptionId.
 */
export interface SubscriptionStore {
  /** Persist or overwrite a subscription (upsert semantics). */
  save(subscription: ServerSubscription): Promise<void>;
  /** Retrieve a subscription by id, or undefined if not found. */
  get(subscriptionId: string): Promise<ServerSubscription | undefined>;
  /** Remove a subscription. No-op if it doesn't exist. */
  delete(subscriptionId: string): Promise<void>;
  /** Return all stored subscriptions (used to warm the in-memory cache on startup). */
  getAll(): Promise<ServerSubscription[]>;
}

/** Request body for PUT /subscriptions (create or update) */
export interface UpdateSubscriptionRequest {
  clientFilter: SubscriptionFilter;
  /** Server-enforced additions to merge into the filter (e.g. accountId). Not sent by the client. */
  serverAdditions?: SubscriptionFilter;
  previousSubscriptionId?: string;
}

/**
 * Interface that a server adapter must implement to persist and query records.
 * Framework-agnostic; implementors plug in their own storage layer.
 */
export interface SyncStore<T extends SyncRecord> {
  /** Fetch records matching a filter that have been updated since the given token. */
  getRecordsSince(
    filter: SubscriptionFilter,
    since: SyncToken
  ): Promise<SyncPatch<T>[]>;

  /** Write a record. Returns the stored record. */
  upsert(record: T): Promise<T>;

  /** Returns the current server record for a given id, or null. */
  getById(recordId: string): Promise<T | null>;

  /**
   * Optional: compute a smarter sync token when a subscription filter changes,
   * avoiding a full re-sync when only a subset of the data is new to the client.
   *
   * Called by SyncHandler.updateSubscription() when the merged filter changes.
   * If absent, filter changes always fall back to a full re-sync (EMPTY_SYNC_TOKEN).
   *
   * ## What to implement
   *
   * The store should find the oldest record that matches `newFilter` but was NOT
   * covered by `oldFilter` (i.e. the "newly added" portion of the scope), then
   * return a token positioned just before that record.
   *
   * The returned token is used as the new subscription's starting point, so that
   * `getRecordsSince(newFilter, returnedToken)` yields exactly:
   *   - records newly in scope (matched by newFilter but not oldFilter), plus
   *   - any records that changed since `existingToken` (already-in-scope updates).
   *
   * ## Cases
   *
   * - **Filter only narrows** (e.g. time window moves forward, dropping old records):
   *   No new records to sync in; return `existingToken` unchanged.
   *   The client handles eviction of now-out-of-scope records locally.
   *
   * - **Filter expands** (e.g. time window moves backward or broadens a category):
   *   Find the oldest record in the newly covered range and return a token just
   *   before it, so the client receives that delta on the next pull.
   *
   * - **Cannot determine a safe partial token** (e.g. complex filter change):
   *   Return `EMPTY_SYNC_TOKEN` to signal that a full re-sync is required.
   *
   * ## Example (SQLite / rolling time window)
   *
   * ```ts
   * async computePartialSyncToken(oldFilter, newFilter, existingToken) {
   *   // Find the oldest record now in scope that wasn't before.
   *   const delta = subtractFilter(newFilter, oldFilter); // store-specific helper
   *   if (!delta) return existingToken; // filter only narrowed, no new data
   *
   *   const oldest = db.prepare(
   *     `SELECT updatedAt, revisionCount, recordId FROM records
   *      WHERE ${filterToSql(delta).clauses}
   *      ORDER BY updatedAt ASC, revisionCount ASC, recordId ASC
   *      LIMIT 1`
   *   ).get(filterToSql(delta).params);
   *
   *   if (!oldest) return existingToken; // delta is empty, nothing new
   *
   *   // Position token just before the oldest delta record.
   *   return encodeSyncToken({
   *     updatedAt: oldest.updatedAt - 1,
   *     revisionCount: 0,
   *     recordId: "",
   *   });
   * }
   * ```
   */
  computePartialSyncToken?(
    oldFilter: SubscriptionFilter,
    newFilter: SubscriptionFilter,
    existingToken: SyncToken
  ): Promise<SyncToken>;
}
