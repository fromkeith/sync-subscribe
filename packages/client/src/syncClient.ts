import {
  type SyncRecord,
  type SyncPatch,
  type SyncToken,
  type SubscriptionFilter,
  filtersEqual,
} from "@sync-subscribe/core";
import type {
  ClientSubscription,
  ClientSubscriptionOptions,
  ILocalStore,
  PatchListener,
  PersistedSubscription,
  SyncTransport,
} from "./types.js";
import { InMemoryStore } from "./inMemoryStore.js";

/**
 * High-level client that manages subscriptions, local state, and sync cycles.
 *
 * Pass a custom `store` to use IndexedDB persistence:
 *   new SyncClient(transport, new IdbLocalStore("my-db"))
 *
 * Omit `store` to use the default in-memory LocalStore.
 */
export class SyncClient<T extends SyncRecord> {
  private listeners: PatchListener<T>[] = [];

  readonly store: ILocalStore<T>;

  constructor(
    private readonly transport: SyncTransport,
    store?: ILocalStore<T>,
  ) {
    this.store = store ?? new InMemoryStore<T>();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  async subscribe(
    options: ClientSubscriptionOptions,
  ): Promise<ClientSubscription> {
    const { name } = options;

    // If named and no explicit previousSubscriptionId, try to restore from store.
    let previousSubscriptionId = options.previousSubscriptionId;
    let storedSub: PersistedSubscription | undefined;

    if (name && previousSubscriptionId === undefined) {
      storedSub = await this.store.getSubscription(name);
      if (storedSub) {
        previousSubscriptionId = storedSub.subscriptionId;
      }
    } else if (previousSubscriptionId !== undefined) {
      storedSub = await this.store.getSubscriptionById(previousSubscriptionId);
    }

    // new sub, or one that needs to change
    const filtersAreEqual = storedSub
      ? filtersEqual(storedSub.filter, options.filter)
      : false;
    if (!storedSub || filtersAreEqual === false) {
      const result = await this.transport.createSubscription(
        options.filter,
        previousSubscriptionId,
      );
      if (storedSub && storedSub.subscriptionId !== result.subscriptionId) {
        throw new Error("SubscriptionId mismatch from server");
      }
      // save the updated subscription
      await this.store.setSubscription(name ?? result.subscriptionId, {
        subscriptionId: result.subscriptionId,
        filter: result.filter,
        syncToken: result.syncToken,
      });
      if (storedSub && result.resetRequired) {
        // evit the old filter, but keep new filter
        await this.store.evict(storedSub.filter, true);
      }
      storedSub = result;
    }
    return storedSub;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /** Pull all pending patches for every active subscription. */
  async pull(): Promise<void> {
    const subscriptions = await this.store.listSubscriptions();
    for (const sub of subscriptions) {
      const { patches, syncToken } = await this.transport.pull(
        sub.subscriptionId,
        sub.syncToken,
      );
      // Cast is safe because T extends SyncRecord and we own both sides.
      const applied = await this.store.applyPatches(
        patches as SyncPatch<T>[],
        syncToken,
      );
      if (applied.length > 0) {
        this.emit(applied);
      }
    }
  }

  /**
   * Write a record locally (read-your-own-writes) then push to server.
   * Returns true on success, false if a conflict was detected.
   */
  async mutate(record: T): Promise<boolean> {
    await this.store.write(record);

    // TODO: figure out which subscriptions this affected
    // then push that data... or just push that data..
    // we shouldn't need a subscriptoin to push data

    const subscriptions = await this.store.listSubscriptions();
    if (!subscriptions) {
      // No active subscription yet; queue for later (not implemented here).
      return true;
    }

    // const result = await this.transport.push(sub.subscriptionId, [record]);

    // if ("conflict" in result && result.conflict) {
    //   // Server wins: overwrite local record with server version.
    //   await this.store.applyPatches([
    //     { op: "upsert", record: result.serverRecord as T },
    //   ]);
    //   this.emit([{ op: "upsert", record: result.serverRecord as T }]);
    //   return false;
    // }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Listeners
  // ---------------------------------------------------------------------------

  onPatches(listener: PatchListener<T>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(patches: SyncPatch<T>[]): void {
    for (const l of this.listeners) l(patches);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Open an SSE stream for a subscription. Patches are applied to the local
   * store and patch listeners are notified automatically.
   *
   * Requires transport.stream to be implemented.
   * Returns a cleanup function — call it to close the connection.
   */
  async stream(subscriptionId: string): Promise<() => void> {
    if (!this.transport.stream) {
      throw new Error(
        "Transport does not support streaming — implement transport.stream()",
      );
    }
    const sub = await this.store.getSubscriptionById(subscriptionId);
    if (!sub) {
      throw new Error(`Unknown subscription: ${subscriptionId}`);
    }
    return this.transport.stream(
      subscriptionId,
      sub.syncToken,
      async ({ patches, syncToken }) => {
        const applied = await this.store.applyPatches(
          patches as SyncPatch<T>[],
          syncToken,
        );
        if (applied.length > 0) this.emit(applied);
      },
      (err) => console.error("[SyncClient] SSE error:", err),
    );
  }

  getSubscriptionById(id: string): Promise<ClientSubscription | undefined> {
    return this.store.getSubscriptionById(id);
  }

  getSubscription(name: string): Promise<ClientSubscription | undefined> {
    return this.store.getSubscription(name);
  }

  /** Resets sync state (useful for logout / account switch). */
  async reset(): Promise<void> {
    await this.store.clear();
    await this.store.clearSubscriptions();
  }
}
