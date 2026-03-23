import {
  EMPTY_SYNC_TOKEN,
  encodeSyncToken,
  filtersEqual,
} from "@sync-subscribe/core";
import type {
  SyncRecord,
  SyncToken,
  SubscriptionFilter,
} from "@sync-subscribe/core";
import type { ServerSubscription, SubscriptionStore } from "./types.js";
import { randomUUID } from "crypto";
import { InMemorySubscriptionStore } from "./inMemoryStore.js";

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
 * Manages the lifecycle of server-side subscriptions.
 *
 * Thin pass-through to a SubscriptionStore — no caching.
 * If you need caching, implement it in your SubscriptionStore.
 *
 * Usage with persistence:
 *   const manager = new SubscriptionManager(myDbStore);
 *
 * Usage without persistence (development / testing):
 *   const manager = new SubscriptionManager();
 */
export class SubscriptionManager<T extends SyncRecord> {
  constructor(
    private readonly store: SubscriptionStore = new InMemorySubscriptionStore(),
  ) {}

  /**
   * Creates a brand-new subscription.
   */
  async create(
    clientFilter: SubscriptionFilter,
    serverAdditions: SubscriptionFilter = {},
  ): Promise<ServerSubscription> {
    const sub = makeSubscription(clientFilter, serverAdditions, EMPTY_SYNC_TOKEN);
    await this.store.save(sub);
    return sub;
  }

  /**
   * Replaces an existing subscription with a new filter.
   *
   * - If the merged filter is unchanged → preserves the old syncToken (partial sync).
   * - If the filter changed → resets syncToken to EMPTY (full re-sync required).
   *
   * Returns the updated subscription and a `resetRequired` flag the client should act on.
   */
  async update(
    previousId: string,
    newClientFilter: SubscriptionFilter,
    serverAdditions: SubscriptionFilter = {},
  ): Promise<{ subscription: ServerSubscription; resetRequired: boolean }> {
    const old = await this.store.get(previousId);

    const newServerFilter: SubscriptionFilter = {
      ...newClientFilter,
      ...serverAdditions,
    };
    const resetRequired = !old || !filtersEqual(old.serverFilter, newServerFilter);
    const syncToken = resetRequired ? EMPTY_SYNC_TOKEN : old!.syncToken;

    const subscription: ServerSubscription = {
      subscriptionId: previousId,
      clientFilter: newClientFilter,
      filter: newClientFilter,
      serverFilter: newServerFilter,
      syncToken,
    };
    await this.store.save(subscription);
    return { subscription, resetRequired };
  }

  async get(subscriptionId: string): Promise<ServerSubscription | undefined> {
    return this.store.get(subscriptionId);
  }

  /**
   * Removes a subscription.
   */
  async delete(subscriptionId: string): Promise<void> {
    await this.store.delete(subscriptionId);
  }

  /**
   * Advances the sync token after records are sent to the client.
   * Returns the new token so callers don't need to re-fetch the subscription.
   * Persistence is fire-and-forget.
   */
  updateSyncToken(subscriptionId: string, lastRecord: SyncRecord): SyncToken {
    const token = encodeSyncToken({
      updatedAt: lastRecord.updatedAt,
      revisionCount: lastRecord.revisionCount,
      recordId: lastRecord.recordId,
    });
    this.store.setToken(subscriptionId, token).catch(console.error);
    return token;
  }

  /**
   * Directly sets a raw sync token on a subscription.
   * Persistence is fire-and-forget.
   */
  setToken(subscriptionId: string, token: SyncToken): void {
    this.store.setToken(subscriptionId, token).catch(console.error);
  }
}
