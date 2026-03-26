import type {
  SyncRecord,
  SyncPatch,
  SyncToken,
  SubscriptionFilter,
  Subscription,
  StreamEvent,
} from "@sync-subscribe/core";

export type SubscriptionStatus = "pending_gap_fill" | "active";

export interface ClientSubscriptionOptions {
  filter: SubscriptionFilter;
  /** Stable client-side name for this subscription. Used to persist and restore state across sessions. */
  name?: string;
  /**
   * If provided, the new subscription replaces the existing one with this ID.
   * Used locally only — no server call is made. Triggers gap/eviction analysis.
   */
  previousSubscriptionId?: string;
}

export interface ClientSubscription extends Subscription {
  /** Stable client-side name, if one was given when subscribing. */
  name?: string;
  status?: SubscriptionStatus;
  gapSubscriptionId?: string;
}

/** Subscription state persisted to the local store, keyed by name. */
export interface PersistedSubscription extends Subscription {
  name?: string;
  /**
   * Omitted or "active" — subscription participates in pull and stream normally.
   * "pending_gap_fill" — a gap sub is in progress; only the gap sub is pulled,
   * and this subscription is excluded from the stream until it transitions to active.
   */
  status?: SubscriptionStatus;
  /**
   * Set when status === "pending_gap_fill". The subscriptionId of the gap subscription
   * that is filling in records not covered by any existing subscription.
   */
  gapSubscriptionId?: string;
}

/** One entry sent in a pull or stream request. key is echoed back in syncTokens responses. */
export interface SyncSubscriptionRequest {
  key: string;
  filter: SubscriptionFilter;
  syncToken: SyncToken;
}

/** Minimal HTTP transport interface — swap in fetch, axios, etc. */
export interface SyncTransport {
  /**
   * Pull patches for all active subscriptions in a single request.
   * Returns deduplicated patches and one sync token per affected subscription key.
   */
  pull(subscriptions: SyncSubscriptionRequest[]): Promise<{
    patches: SyncPatch<SyncRecord>[];
    syncTokens: Record<string, SyncToken>;
  }>;

  /**
   * Push locally-mutated records to the server.
   * Returns serverUpdatedAt on success so the client can stamp local copies.
   */
  push(
    records: SyncRecord[],
  ): Promise<
    | { ok: true; serverUpdatedAt: number }
    | { conflict: true; serverRecord: SyncRecord }
  >;

  /**
   * Optional POST-based SSE streaming for all active subscriptions.
   * Returns a cleanup function that closes the connection.
   */
  stream?(
    subscriptions: SyncSubscriptionRequest[],
    onMessage: (event: StreamEvent) => void,
    onError?: (err: Error) => void,
  ): () => void;
}

/**
 * Async interface for local record storage.
 * Both InMemoryStore and IdbLocalStore implement this.
 */
export interface ILocalStore<T extends SyncRecord> {
  /**
   * Apply a batch of patches from the server.
   * On upsert, copies `record.updatedAt` into `record.serverUpdatedAt` before storing
   * (the server's clock is authoritative).
   * Returns the patches that were actually applied (conflict resolution may drop some).
   */
  applyPatches(patches: SyncPatch<T>[]): Promise<SyncPatch<T>[]>;
  write(record: T): Promise<void>;
  getAll(): Promise<T[]>;
  query(filter: SubscriptionFilter<T>): Promise<T[]>;
  count(filter: SubscriptionFilter<T>): Promise<number>;
  delete(fiter: SubscriptionFilter<T>): Promise<void>;
  getById(recordId: string): Promise<T | undefined>;
  /** Remove all records — called by SyncClient.reset(). */
  clear(): Promise<void>;
  /**
   * Removes items from our local store that match the filter.
   * Does not delete them from other stores/devices.
   */
  evict(evictFilter: SubscriptionFilter<T>): Promise<void>;
  /**
   * Scan local records matching filter, find the max (serverUpdatedAt, revisionCount, recordId),
   * and return encodeSyncToken(that record). Returns EMPTY_SYNC_TOKEN if no records have
   * serverUpdatedAt set (i.e. none have been confirmed by the server yet).
   */
  reconstructSyncToken(filter: SubscriptionFilter<T>): Promise<SyncToken>;
  /**
   * Stamp a server-authoritative timestamp on a local record after a successful push.
   * This keeps reconstructSyncToken accurate without a full record rewrite.
   */
  setServerUpdatedAt(recordId: string, serverUpdatedAt: number): Promise<void>;
  /** Persist the latest sync token for an unnamed subscription across sessions. */
  setSyncToken(subscriptionId: string, token: SyncToken): Promise<void>;
  getSyncToken(subscriptionId: string): Promise<SyncToken | undefined>;
  /** Persist full subscription state under a stable client-side name (or subscriptionId). */
  setSubscription(name: string, sub: PersistedSubscription): Promise<void>;
  getSubscription(name: string): Promise<PersistedSubscription | undefined>;
  getSubscriptionById(id: string): Promise<PersistedSubscription | undefined>;
  removeSubscription(name: string): Promise<void>;
  listSubscriptions(): Promise<PersistedSubscription[]>;
  /** Remove all persisted subscriptions — called by SyncClient.reset(). */
  clearSubscriptions(): Promise<void>;
}

/** Called whenever the local store changes due to incoming patches. */
export type PatchListener<T extends SyncRecord> = (
  patches: SyncPatch<T>[],
) => void;
