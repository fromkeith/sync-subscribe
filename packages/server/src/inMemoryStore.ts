import type { SyncToken } from "@sync-subscribe/core";
import type { ServerSubscription, SubscriptionStore } from "./types.js";
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

  async setToken(id: string, token: SyncToken): Promise<void> {
    const sub = this.data.get(id);
    if (sub) sub.syncToken = token;
  }

  async delete(id: string): Promise<void> {
    this.data.delete(id);
  }

  async getAll(): Promise<ServerSubscription[]> {
    return [...this.data.values()];
  }
}
