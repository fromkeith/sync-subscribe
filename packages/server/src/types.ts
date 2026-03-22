import type {
  ConflictResult,
  SyncPatch,
  SyncRecord,
  SyncToken,
  Subscription,
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
  /** The client-supplied filter, echoed back so the client can store it. */
  filter: SubscriptionFilter;
  syncToken: SyncToken;
  /**
   * True when the filter changed on update and the client should evict
   * data that no longer matches the new filter, then do a full re-sync.
   * Always false for brand-new subscriptions.
   */
  resetRequired: boolean;
}

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
 */
export interface SubscriptionStore {
  save(subscription: ServerSubscription): Promise<void>;
  get(subscriptionId: string): Promise<ServerSubscription | undefined>;
  delete(subscriptionId: string): Promise<void>;
  getAll(): Promise<ServerSubscription[]>;
}

/** Request body for PUT /subscriptions (create or update) */
export interface UpdateSubscriptionRequest {
  clientFilter: SubscriptionFilter;
  serverAdditions?: SubscriptionFilter;
  previousSubscriptionId?: string;
}

/**
 * Interface that a server adapter must implement to persist and query records.
 * Framework-agnostic; implementors plug in their own storage layer.
 */
export interface SyncStore<T extends SyncRecord> {
  /**
   * Fetch records matching one or more subscription filters, each with its own
   * since-token. Implementations should query using a union of all filters
   * and return deduplicated patches ordered by (updatedAt, revisionCount, recordId) ascending.
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
