import type {
  SyncRecord,
  SyncPatch,
  SyncToken,
  SubscriptionFilter,
} from "@sync-subscribe/core";
import { resolveConflict, matchesFilter } from "@sync-subscribe/core";
import type { ILocalStore, PersistedSubscription } from "./types.js";

/**
 * Minimal in-memory local store.
 *
 */
export class InMemoryStore<T extends SyncRecord> implements ILocalStore<T> {
  private records = new Map<string, T>();
  private syncTokens = new Map<string, SyncToken>();
  private subscriptions = new Map<string, PersistedSubscription>();

  /** Apply a batch of patches from the server. Returns applied patches. */
  async applyPatches(patches: SyncPatch<T>[]): Promise<SyncPatch<T>[]> {
    const applied: SyncPatch<T>[] = [];

    for (const patch of patches) {
      if (patch.op === "delete") {
        this.records.delete(patch.recordId);
        applied.push(patch);
      } else {
        const existing = this.records.get(patch.record.recordId);
        if (!existing || resolveConflict(patch.record, existing) === "a") {
          this.records.set(patch.record.recordId, patch.record);
          applied.push(patch);
        }
      }
    }

    return applied;
  }

  /**
   * Write a record locally (client mutation — read-your-own-writes).
   * Does NOT push to the server; the caller is responsible for that.
   */
  async write(record: T): Promise<void> {
    this.records.set(record.recordId, record);
  }

  async getAll(): Promise<T[]> {
    return [...this.records.values()];
  }

  async getById(recordId: string): Promise<T | undefined> {
    return this.records.get(recordId);
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.syncTokens.clear();
  }

  async setSubscription(
    name: string,
    sub: PersistedSubscription,
  ): Promise<void> {
    this.subscriptions.set(name, sub);
  }

  async getSubscription(
    name: string,
  ): Promise<PersistedSubscription | undefined> {
    return this.subscriptions.get(name);
  }

  async removeSubscription(name: string): Promise<void> {
    this.subscriptions.delete(name);
  }

  async clearSubscriptions(): Promise<void> {
    this.subscriptions.clear();
    this.syncTokens.clear();
  }

  async setSyncToken(subscriptionId: string, token: SyncToken): Promise<void> {
    this.syncTokens.set(subscriptionId, token);
  }

  async getSyncToken(subscriptionId: string): Promise<SyncToken | undefined> {
    return this.syncTokens.get(subscriptionId);
  }

  async evict(
    evictFilter: SubscriptionFilter,
    retainFilters: SubscriptionFilter[],
  ): Promise<void> {
    for (const [id, record] of this.records) {
      if (
        matchesFilter(record as Record<string, unknown>, evictFilter) &&
        !retainFilters.some((f) =>
          matchesFilter(record as Record<string, unknown>, f),
        )
      ) {
        this.records.delete(id);
      }
    }
  }
}
