import type {
  SyncRecord,
  SyncPatch,
  SyncToken,
  SubscriptionFilter,
} from "@sync-subscribe/core";
import {
  resolveConflict,
  matchesFilter,
  encodeSyncToken,
  EMPTY_SYNC_TOKEN,
} from "@sync-subscribe/core";
import type { ILocalStore, PersistedSubscription } from "./types.js";

/**
 * Minimal in-memory local store. State is lost on page reload.
 * Use IdbLocalStore for persistent storage across sessions.
 */
export class InMemoryStore<T extends SyncRecord> implements ILocalStore<T> {
  private records = new Map<string, T>();
  private syncTokens = new Map<string, SyncToken>();
  private subscriptions = new Map<string, PersistedSubscription>();

  /**
   * Apply a batch of patches from the server.
   * Copies `record.updatedAt` into `record.serverUpdatedAt` on upsert (server clock is authoritative).
   * Returns the patches that were actually applied.
   */
  async applyPatches(patches: SyncPatch<T>[]): Promise<SyncPatch<T>[]> {
    const applied: SyncPatch<T>[] = [];

    for (const patch of patches) {
      if (patch.op === "delete") {
        this.records.delete(patch.recordId);
        applied.push(patch);
      } else {
        const existing = this.records.get(patch.record.recordId);
        if (!existing || resolveConflict(patch.record, existing) === "a") {
          // Stamp serverUpdatedAt from the server's updatedAt
          const withServerTs: T = {
            ...patch.record,
            serverUpdatedAt: patch.record.updatedAt,
          };
          this.records.set(withServerTs.recordId, withServerTs);
          applied.push({ op: "upsert", record: withServerTs });
        }
      }
    }

    return applied;
  }

  async write(record: T): Promise<void> {
    this.records.set(record.recordId, record);
  }

  async getAll(): Promise<T[]> {
    return [...this.records.values()];
  }

  async query(filter: SubscriptionFilter): Promise<T[]> {
    return [...this.records.values()].filter((r) =>
      matchesFilter(r as Record<string, unknown>, filter),
    );
  }

  async count(filter: SubscriptionFilter): Promise<number> {
    return (await this.query(filter)).length;
  }

  async getById(recordId: string): Promise<T | undefined> {
    return this.records.get(recordId);
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.syncTokens.clear();
  }

  async delete(filter: SubscriptionFilter): Promise<void> {
    for (const [id, record] of this.records) {
      if (matchesFilter(record as Record<string, unknown>, filter)) {
        this.records.delete(id);
      }
    }
  }

  async evict(evictFilter: SubscriptionFilter): Promise<void> {
    return this.delete(evictFilter);
  }

  async reconstructSyncToken(
    filter: SubscriptionFilter<T>,
  ): Promise<SyncToken> {
    let best: T | undefined;

    for (const record of this.records.values()) {
      if (record.serverUpdatedAt === undefined) continue;
      if (!matchesFilter(record as Record<string, unknown>, filter)) continue;

      if (
        !best ||
        record.serverUpdatedAt > best.serverUpdatedAt! ||
        (record.serverUpdatedAt === best.serverUpdatedAt &&
          record.revisionCount > best.revisionCount) ||
        (record.serverUpdatedAt === best.serverUpdatedAt &&
          record.revisionCount === best.revisionCount &&
          record.recordId > best.recordId)
      ) {
        best = record;
      }
    }

    if (!best || best.serverUpdatedAt === undefined) return EMPTY_SYNC_TOKEN;

    return encodeSyncToken({
      updatedAt: best.serverUpdatedAt,
      revisionCount: best.revisionCount,
      recordId: best.recordId,
    });
  }

  async setServerUpdatedAt(
    recordId: string,
    serverUpdatedAt: number,
  ): Promise<void> {
    const record = this.records.get(recordId);
    if (record) {
      this.records.set(recordId, { ...record, serverUpdatedAt });
    }
  }

  async setSyncToken(subscriptionId: string, token: SyncToken): Promise<void> {
    this.syncTokens.set(subscriptionId, token);
  }

  async getSyncToken(subscriptionId: string): Promise<SyncToken | undefined> {
    return this.syncTokens.get(subscriptionId);
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

  async getSubscriptionById(
    id: string,
  ): Promise<PersistedSubscription | undefined> {
    for (const sub of this.subscriptions.values()) {
      if (sub.subscriptionId === id) return sub;
    }
    return undefined;
  }

  async listSubscriptions(): Promise<PersistedSubscription[]> {
    return [...this.subscriptions.values()];
  }

  async removeSubscription(name: string): Promise<void> {
    this.subscriptions.delete(name);
  }

  async clearSubscriptions(): Promise<void> {
    this.subscriptions.clear();
    this.syncTokens.clear();
  }
}
