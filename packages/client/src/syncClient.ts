import type { SyncRecord, SyncPatch } from "@sync-subscribe/core";
import type {
  ClientSubscription,
  ClientSubscriptionOptions,
  ILocalStore,
  PatchListener,
  SyncTransport,
} from "./types.js";
import { LocalStore } from "./localStore.js";

/**
 * High-level client that manages subscriptions, local state, and sync cycles.
 *
 * Pass a custom `store` to use IndexedDB persistence:
 *   new SyncClient(transport, new IdbLocalStore("my-db"))
 *
 * Omit `store` to use the default in-memory LocalStore.
 */
export class SyncClient<T extends SyncRecord> {
  private subscriptions = new Map<string, ClientSubscription>();
  private listeners: PatchListener<T>[] = [];

  readonly store: ILocalStore<T>;

  constructor(
    private readonly transport: SyncTransport,
    store?: ILocalStore<T>,
  ) {
    this.store = store ?? new LocalStore<T>();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  async subscribe(options: ClientSubscriptionOptions): Promise<ClientSubscription> {
    const sub = await this.transport.createSubscription(
      options.filter,
      options.previousSubscriptionId
    );
    this.subscriptions.set(sub.subscriptionId, sub);
    return sub;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /** Pull all pending patches for every active subscription. */
  async pull(): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      const { patches, syncToken } = await this.transport.pull(
        sub.subscriptionId,
        sub.syncToken
      );

      // Cast is safe because T extends SyncRecord and we own both sides.
      const applied = await this.store.applyPatches(patches as SyncPatch<T>[]);
      sub.syncToken = syncToken;

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

    const [sub] = this.subscriptions.values();
    if (!sub) {
      // No active subscription yet; queue for later (not implemented here).
      return true;
    }

    const result = await this.transport.push(sub.subscriptionId, [record]);

    if ("conflict" in result && result.conflict) {
      // Server wins: overwrite local record with server version.
      await this.store.applyPatches([
        { op: "upsert", record: result.serverRecord as T },
      ]);
      this.emit([{ op: "upsert", record: result.serverRecord as T }]);
      return false;
    }

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

  getSubscription(id: string): ClientSubscription | undefined {
    return this.subscriptions.get(id);
  }

  /** Resets sync state (useful for logout / account switch). */
  async reset(): Promise<void> {
    this.subscriptions.clear();
    await this.store.clear();
  }
}
