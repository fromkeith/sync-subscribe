import { resolveConflict, EMPTY_SYNC_TOKEN } from "@sync-subscribe/core";
import type { SyncRecord, SubscriptionFilter } from "@sync-subscribe/core";
import type {
  CreateSubscriptionResponse,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
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
    private readonly options: SyncHandlerOptions<T> = {}
  ) {}

  /**
   * Creates or updates a subscription, applying a partial sync token when possible.
   *
   * For new subscriptions (no previousSubscriptionId) this is equivalent to
   * SubscriptionManager.create().
   *
   * For updates:
   *  - If the merged filter is unchanged: preserves the existing syncToken (no re-sync).
   *  - If the filter changed AND the store implements computePartialSyncToken:
   *    delegates token computation to the store. A non-empty result avoids a full re-sync
   *    by positioning the client at the start of the delta rather than the beginning of time.
   *  - Otherwise: resets to EMPTY_SYNC_TOKEN (full re-sync).
   *
   * `resetRequired` in the response signals that the client should evict records
   * that no longer match the new filter before pulling.
   */
  async updateSubscription(
    clientFilter: SubscriptionFilter,
    serverAdditions: SubscriptionFilter = {},
    previousSubscriptionId?: string
  ): Promise<CreateSubscriptionResponse> {
    if (!previousSubscriptionId) {
      const sub = await this.subscriptions.create(clientFilter, serverAdditions);
      return { subscriptionId: sub.subscriptionId, syncToken: sub.syncToken, resetRequired: false };
    }

    const old = this.subscriptions.get(previousSubscriptionId);
    const { subscription, resetRequired } = await this.subscriptions.update(
      previousSubscriptionId,
      clientFilter,
      serverAdditions
    );

    // If the filter changed and the store can compute a partial token, use it.
    // This lets the client skip records it already has instead of re-syncing from scratch.
    if (resetRequired && old && this.store.computePartialSyncToken) {
      const partialToken = await this.store.computePartialSyncToken(
        old.serverFilter,
        subscription.serverFilter,
        old.syncToken
      );
      if (partialToken !== EMPTY_SYNC_TOKEN) {
        this.subscriptions.setToken(subscription.subscriptionId, partialToken);
        return {
          subscriptionId: subscription.subscriptionId,
          syncToken: partialToken,
          // resetRequired stays true: the client still needs to evict records that
          // no longer match the new filter. The smarter token only means the pull
          // will cover the delta rather than everything from the beginning of time.
          resetRequired: true,
        };
      }
    }

    return {
      subscriptionId: subscription.subscriptionId,
      syncToken: subscription.syncToken,
      resetRequired,
    };
  }

  async pull(req: PullRequest): Promise<PullResponse<T>> {
    const sub = this.subscriptions.get(req.subscriptionId);
    if (!sub) {
      throw new Error(`Unknown subscription: ${req.subscriptionId}`);
    }

    const patches = await this.store.getRecordsSince(sub.serverFilter, req.syncToken);

    // Advance the sync token to the last upserted record we're returning.
    const lastUpsert = [...patches].reverse().find((p) => p.op === "upsert");
    if (lastUpsert && lastUpsert.op === "upsert") {
      this.subscriptions.updateSyncToken(req.subscriptionId, lastUpsert.record);
    }

    return { patches, syncToken: this.subscriptions.get(req.subscriptionId)!.syncToken };
  }

  async push(req: PushRequest<T>): Promise<PushResponse<T>> {
    const { readonlyFields, onRecordsChanged } = this.options;
    const stored: T[] = [];

    for (const incoming of req.records) {
      const existing = await this.store.getById(incoming.recordId);

      // Apply readonly field protection: copy server values over client-supplied ones.
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

      // Stamp server-authoritative timestamps before storing.
      const now = Date.now();
      const toStore: T = {
        ...record,
        updatedAt: now,
        // For new records: stamp createdAt with server time.
        // For existing records: preserve the server's original createdAt.
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
   * Upserts a record from the server itself (background job, webhook, another service, etc.).
   *
   * Unlike push(), there is no conflict resolution — the server's intent wins.
   * The server does, however:
   *   - Preserve readonly fields from the existing record (same rule as push)
   *   - Stamp authoritative timestamps (updatedAt = now, createdAt preserved for existing records)
   *   - Increment revisionCount so clients can detect the change via conflict resolution
   *   - Fire onRecordsChanged so SSE subscribers are notified
   *
   * Returns the record as it was written to the store.
   */
  async serverUpsert(record: T): Promise<T> {
    const { readonlyFields, onRecordsChanged } = this.options;
    const existing = await this.store.getById(record.recordId);

    // Apply readonly field protection: copy server values over the incoming record.
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
      // Server increments revisionCount because it is the author of this change.
      revisionCount: (existing?.revisionCount ?? 0) + 1,
    };

    const stored = await this.store.upsert(toStore);
    onRecordsChanged?.([stored]);
    return stored;
  }
}
