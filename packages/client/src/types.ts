import type {
  SyncRecord,
  SyncPatch,
  SyncToken,
  SubscriptionFilter,
} from "@sync-subscribe/core";

export interface ClientSubscriptionOptions {
  filter: SubscriptionFilter;
  /** If provided, replaces an existing subscription on the server. */
  previousSubscriptionId?: string;
}

export interface ClientSubscription {
  subscriptionId: string;
  filter: SubscriptionFilter;
  syncToken: SyncToken;
}

/** Minimal HTTP transport interface — swap in fetch, axios, etc. */
export interface SyncTransport {
  createSubscription(
    filter: SubscriptionFilter,
    previousSubscriptionId?: string
  ): Promise<ClientSubscription>;

  pull(subscriptionId: string, syncToken: SyncToken): Promise<{
    patches: SyncPatch<SyncRecord>[];
    syncToken: SyncToken;
  }>;

  push(subscriptionId: string, records: SyncRecord[]): Promise<
    | { ok: true }
    | { conflict: true; serverRecord: SyncRecord }
  >;
}

/**
 * Async interface for local record storage.
 * Both LocalStore (in-memory) and IdbLocalStore (IndexedDB) implement this.
 */
export interface ILocalStore<T extends SyncRecord> {
  applyPatches(patches: SyncPatch<T>[]): Promise<SyncPatch<T>[]>;
  write(record: T): Promise<void>;
  getAll(): Promise<T[]>;
  getById(recordId: string): Promise<T | undefined>;
  /** Remove all records — called by SyncClient.reset(). */
  clear(): Promise<void>;
}

/** Called whenever the local store changes due to incoming patches. */
export type PatchListener<T extends SyncRecord> = (patches: SyncPatch<T>[]) => void;
