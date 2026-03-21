import type {
  SyncRecord,
  SyncPatch,
  SyncToken,
  SubscriptionFilter,
  Subscription,
} from "@sync-subscribe/core";

export interface ClientSubscriptionOptions {
  filter: SubscriptionFilter;
  /** Stable client-side name for this subscription. Used to persist and restore state across sessions. */
  name?: string;
  /** If provided, replaces an existing subscription on the server. */
  previousSubscriptionId?: string;
}

export interface ClientSubscription extends Subscription {
  /** Stable client-side name, if one was given when subscribing. */
  name?: string;
  resetRequired?: boolean;
}

/** Subscription state persisted to the local store, keyed by name. */
export interface PersistedSubscription extends Subscription {
  name?: string;
}

/** Minimal HTTP transport interface — swap in fetch, axios, etc. */
export interface SyncTransport {
  createSubscription(
    filter: SubscriptionFilter,
    previousSubscriptionId?: string,
  ): Promise<ClientSubscription>;

  pull(
    subscriptionId: string,
    syncToken: SyncToken,
  ): Promise<{
    patches: SyncPatch<SyncRecord>[];
    syncToken: SyncToken;
  }>;

  push(
    subscriptionId: string,
    records: SyncRecord[],
  ): Promise<{ ok: true } | { conflict: true; serverRecord: SyncRecord }>;

  /**
   * Optional SSE streaming. When implemented, use SyncClient.stream() instead of polling.
   * Returns a cleanup function that closes the connection.
   */
  stream?(
    subscriptionId: string,
    syncToken: SyncToken,
    onMessage: (payload: {
      patches: SyncPatch<SyncRecord>[];
      syncToken: SyncToken;
    }) => void,
    onError?: (err: Error) => void,
  ): () => void;
}

/**
 * Async interface for local record storage.
 * Both LocalStore (in-memory) and IdbLocalStore (IndexedDB) implement this.
 */
export interface ILocalStore<T extends SyncRecord> {
  applyPatches(
    patches: SyncPatch<T>[],
    newSyncToken: SyncToken,
  ): Promise<SyncPatch<T>[]>;
  write(record: T): Promise<void>;
  getAll(): Promise<T[]>;
  getById(recordId: string): Promise<T | undefined>;
  /** Remove all records — called by SyncClient.reset(). */
  clear(): Promise<void>;
  /**
   * Remove records that match evictFilter. if retainOtherSubs is true
   * then we should retain items defined by the other subs
   */
  evict(
    evictFilter: SubscriptionFilter<T>,
    retainOtherSubs: boolean,
  ): Promise<void>;
  /** Persist the latest sync token for an unnamed subscription across sessions. */
  setSyncToken(subscriptionId: string, token: SyncToken): Promise<void>;
  getSyncToken(subscriptionId: string): Promise<SyncToken | undefined>;
  /** Persist full subscription state under a stable client-side name. */
  setSubscription(name: string, sub: PersistedSubscription): Promise<void>;
  getSubscription(name: string): Promise<PersistedSubscription | undefined>;
  getSubscriptionById(name: string): Promise<PersistedSubscription | undefined>;
  removeSubscription(name: string): Promise<void>;
  listSubscriptions(): Promise<PersistedSubscription[]>;
  /** Remove all persisted subscriptions — called by SyncClient.reset(). */
  clearSubscriptions(): Promise<void>;
}

/** Called whenever the local store changes due to incoming patches. */
export type PatchListener<T extends SyncRecord> = (
  patches: SyncPatch<T>[],
) => void;
