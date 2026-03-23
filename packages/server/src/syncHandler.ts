import {
  resolveConflict,
  matchesFilter,
  EMPTY_SYNC_TOKEN,
} from "@sync-subscribe/core";
import type {
  SyncRecord,
  SyncToken,
  SubscriptionFilter,
  SyncPatch,
  ConflictResult,
} from "@sync-subscribe/core";
import type {
  CreateSubscriptionResponse,
  SyncHandlerOptions,
  SyncStore,
} from "./types.js";
import type { SubscriptionManager } from "./subscriptionManager.js";

/**
 * Core sync logic, decoupled from any HTTP framework.
 * Wire this up to your route handlers (Express, Hono, Fastify, …).
 */
export class SyncHandler<T extends SyncRecord> {
  constructor(
    private readonly store: SyncStore<T>,
    private readonly subscriptions: SubscriptionManager<T>,
    private readonly options: SyncHandlerOptions<T> = {},
  ) {}

  /**
   * Creates or updates a subscription, applying a partial sync token when possible.
   */
  async updateSubscription(
    clientFilter: SubscriptionFilter,
    serverAdditions: SubscriptionFilter = {},
    previousSubscriptionId?: string,
  ): Promise<CreateSubscriptionResponse> {
    if (!previousSubscriptionId) {
      const sub = await this.subscriptions.create(clientFilter, serverAdditions);
      return { subscriptionId: sub.subscriptionId, filter: clientFilter, syncToken: sub.syncToken, resetRequired: false };
    }

    const old = await this.subscriptions.get(previousSubscriptionId);
    const { subscription, resetRequired } = await this.subscriptions.update(
      previousSubscriptionId,
      clientFilter,
      serverAdditions,
    );

    if (resetRequired && old && this.store.computePartialSyncToken) {
      const partialToken = await this.store.computePartialSyncToken(
        old.serverFilter,
        subscription.serverFilter,
        old.syncToken,
      );
      if (partialToken !== EMPTY_SYNC_TOKEN) {
        this.subscriptions.setToken(subscription.subscriptionId, partialToken);
        return {
          subscriptionId: subscription.subscriptionId,
          filter: clientFilter,
          syncToken: partialToken,
          resetRequired: true,
        };
      }
    }

    return {
      subscriptionId: subscription.subscriptionId,
      filter: clientFilter,
      syncToken: subscription.syncToken,
      resetRequired,
    };
  }

  async pull(req: {
    subscriptionId: string;
    syncToken: SyncToken;
  }): Promise<{ patches: SyncPatch<T>[]; syncToken: SyncToken }> {
    const sub = await this.subscriptions.get(req.subscriptionId);
    if (!sub) throw new Error(`Unknown subscription: ${req.subscriptionId}`);

    const patches = await this.store.getRecordsSince([
      { filter: sub.serverFilter, since: req.syncToken },
    ]);

    const lastMatch = [...patches]
      .reverse()
      .find(
        (p) =>
          p.op === "upsert" &&
          matchesFilter(p.record as Record<string, unknown>, sub.serverFilter),
      );

    const syncToken = lastMatch && lastMatch.op === "upsert"
      ? this.subscriptions.updateSyncToken(req.subscriptionId, lastMatch.record)
      : sub.syncToken;

    return { patches, syncToken };
  }

  async push(req: { records: T[] }): Promise<{ ok: true } | ConflictResult<T>> {
    const { readonlyFields, onRecordsChanged } = this.options;
    const stored: T[] = [];
    const now = Date.now();

    for (const incoming of req.records) {
      const existing = await this.store.getById(incoming.recordId);

      // Apply readonly field protection
      let record = incoming;
      if (readonlyFields && readonlyFields.length > 0 && existing) {
        const patched = { ...record } as Record<string, unknown>;
        for (const field of readonlyFields) {
          patched[field] = (existing as Record<string, unknown>)[field];
        }
        record = patched as T;
      }

      // Conflict resolution: server wins on higher revisionCount or older updatedAt tie.
      if (existing) {
        const winner = resolveConflict(record, existing);
        if (winner === "b") {
          return { conflict: true, serverRecord: existing };
        }
      }

      const toStore: T = {
        ...record,
        updatedAt: now,
        createdAt: existing ? existing.createdAt : now,
      };

      await this.store.upsert(toStore);
      stored.push(toStore);
    }

    if (stored.length > 0) {
      onRecordsChanged?.(stored);
    }

    return { ok: true };
  }

  /**
   * Upserts a record from the server itself (background job, webhook, etc.).
   * The server's intent always wins — no conflict resolution.
   * Returns the stored record.
   */
  async serverUpsert(record: T): Promise<T> {
    const { readonlyFields, onRecordsChanged } = this.options;
    const existing = await this.store.getById(record.recordId);

    let incoming = record;
    if (readonlyFields && readonlyFields.length > 0 && existing) {
      const patched = { ...incoming } as Record<string, unknown>;
      for (const field of readonlyFields) {
        patched[field] = (existing as Record<string, unknown>)[field];
      }
      incoming = patched as T;
    }

    const now = Date.now();
    const toStore: T = {
      ...incoming,
      updatedAt: now,
      createdAt: existing ? existing.createdAt : now,
      revisionCount: (existing?.revisionCount ?? 0) + 1,
    };

    const stored = await this.store.upsert(toStore);
    onRecordsChanged?.([stored]);
    return stored;
  }
}
