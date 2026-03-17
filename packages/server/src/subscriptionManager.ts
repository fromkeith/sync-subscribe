import { EMPTY_SYNC_TOKEN, encodeSyncToken, filtersEqual } from "@sync-subscribe/core";
import type {
  SyncRecord,
  SyncToken,
  SubscriptionFilter,
} from "@sync-subscribe/core";
import type { ServerSubscription, SubscriptionStore } from "./types.js";
import { randomUUID } from "crypto";

function makeSubscription(
  clientFilter: SubscriptionFilter,
  serverAdditions: SubscriptionFilter,
  syncToken: SyncToken,
): ServerSubscription {
  return {
    subscriptionId: randomUUID(),
    clientFilter,
    filter: clientFilter,
    serverFilter: { ...clientFilter, ...serverAdditions },
    syncToken,
  };
}

/**
 * An in-memory SubscriptionStore. This is the default backing store used by
 * SubscriptionManager when no external store is provided.
 *
 * Passing an instance explicitly lets you share it across processes or inspect
 * its contents in tests. For production persistence, provide a database-backed
 * SubscriptionStore instead.
 */
export class InMemorySubscriptionStore implements SubscriptionStore {
  private data = new Map<string, ServerSubscription>();

  async save(sub: ServerSubscription): Promise<void> {
    this.data.set(sub.subscriptionId, sub);
  }

  async get(id: string): Promise<ServerSubscription | undefined> {
    return this.data.get(id);
  }

  async delete(id: string): Promise<void> {
    this.data.delete(id);
  }

  async getAll(): Promise<ServerSubscription[]> {
    return [...this.data.values()];
  }
}

/**
 * Manages the lifecycle of server-side subscriptions.
 *
 * Keeps an in-memory cache for fast synchronous reads (get, updateSyncToken).
 * Write operations (create, update) are async so they can be awaited in route
 * handlers when a persistent SubscriptionStore is provided.
 *
 * Usage with persistence:
 *   const manager = new SubscriptionManager(myDbStore);
 *   await manager.initialize(); // warm cache from DB on startup
 *
 * Usage without persistence (development / testing):
 *   const manager = new SubscriptionManager();
 */
export class SubscriptionManager<T extends SyncRecord> {
  private cache = new Map<string, ServerSubscription>();

  constructor(
    private readonly store: SubscriptionStore = new InMemorySubscriptionStore(),
  ) {}

  /**
   * Loads all persisted subscriptions into the in-memory cache.
   * Call once during server startup when using a persistent store.
   */
  async initialize(): Promise<void> {
    const all = await this.store.getAll();
    for (const sub of all) {
      this.cache.set(sub.subscriptionId, sub);
    }
  }

  /**
   * Creates a brand-new subscription.
   */
  async create(
    clientFilter: SubscriptionFilter,
    serverAdditions: SubscriptionFilter = {},
  ): Promise<ServerSubscription> {
    const sub = makeSubscription(
      clientFilter,
      serverAdditions,
      EMPTY_SYNC_TOKEN,
    );
    this.cache.set(sub.subscriptionId, sub);
    this.store.save(sub).catch(console.error);
    return sub;
  }

  /**
   * Replaces an existing subscription with a new filter.
   *
   * - If the merged filter is unchanged → preserves the old syncToken (partial sync).
   * - If the filter changed → resets syncToken to EMPTY (full re-sync required).
   *
   * Returns the new subscription and a `resetRequired` flag the client should act on.
   */
  async update(
    previousId: string,
    newClientFilter: SubscriptionFilter,
    serverAdditions: SubscriptionFilter = {},
  ): Promise<{ subscription: ServerSubscription; resetRequired: boolean }> {
    const old = this.cache.get(previousId);
    this.cache.delete(previousId);
    this.store.delete(previousId).catch(console.error);

    const newServerFilter: SubscriptionFilter = {
      ...newClientFilter,
      ...serverAdditions,
    };
    const resetRequired =
      !old || !filtersEqual(old.serverFilter, newServerFilter);
    const syncToken = resetRequired ? EMPTY_SYNC_TOKEN : old!.syncToken;

    const subscription = makeSubscription(
      newClientFilter,
      serverAdditions,
      syncToken,
    );
    this.cache.set(subscription.subscriptionId, subscription);
    this.store.save(subscription).catch(console.error);
    return { subscription, resetRequired };
  }

  get(subscriptionId: string): ServerSubscription | undefined {
    return this.cache.get(subscriptionId);
  }

  /**
   * Advances the sync token for a subscription after records are sent to the client.
   * The in-memory update is synchronous; persistence is fire-and-forget.
   */
  updateSyncToken(subscriptionId: string, lastRecord: SyncRecord): void {
    this.setToken(
      subscriptionId,
      encodeSyncToken({
        updatedAt: lastRecord.updatedAt,
        revisionCount: lastRecord.revisionCount,
        recordId: lastRecord.recordId,
      }),
    );
  }

  /**
   * Directly sets a raw sync token on a subscription.
   * Used by SyncHandler.updateSubscription() to apply a store-computed partial token.
   */
  setToken(subscriptionId: string, token: SyncToken): void {
    const sub = this.cache.get(subscriptionId);
    if (!sub) return;
    sub.syncToken = token;
    this.store.save(sub).catch(console.error);
  }
}
