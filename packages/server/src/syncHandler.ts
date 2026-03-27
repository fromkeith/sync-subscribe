import {
  resolveConflict,
  matchesFilter,
  encodeSyncToken,
  EMPTY_SYNC_TOKEN,
} from "@sync-subscribe/core";
import type {
  SyncRecord,
  SyncToken,
  SyncPatch,
  ConflictResult,
} from "@sync-subscribe/core";
import type {
  SyncHandlerOptions,
  SyncStore,
  SyncSubscriptionRequest,
} from "./types.js";

/**
 * Core sync logic, decoupled from any HTTP framework.
 * Wire this up to your route handlers (Express, Hono, Fastify, …).
 *
 * The server has no concept of stored subscriptions. The client sends its
 * filters and sync tokens directly in every pull/stream request. The route
 * handler is responsible for merging any server-side filter additions
 * (e.g. userId from auth context) before calling pull().
 */
export class SyncHandler<T extends SyncRecord> {
  constructor(
    private readonly store: SyncStore<T>,
    private readonly options: SyncHandlerOptions<T> = {},
  ) {}

  /**
   * Pull patches for one or more subscriptions.
   *
   * Each entry in `subscriptions` carries an opaque `key` (echoed back in
   * the response), a fully-merged filter (client filter + server additions),
   * and the client's last-known sync token.
   *
   * Returns deduplicated patches and one sync token per key.
   */
  async pull(subscriptions: SyncSubscriptionRequest[]): Promise<{
    patches: SyncPatch<T>[];
    syncTokens: Record<string, SyncToken>;
  }> {
    const allPatches = await this.store.getRecordsSince(
      subscriptions.map((s) => ({ filter: s.filter, since: s.syncToken })),
    );

    // Compute the latest sync token per subscription key.
    const syncTokens: Record<string, SyncToken> = {};
    for (const sub of subscriptions) {
      let lastMatch: T | undefined;
      for (const p of allPatches) {
        if (
          p.op === "upsert" &&
          matchesFilter(p.record as Record<string, unknown>, sub.filter)
        ) {
          lastMatch = p.record as T;
        }
      }
      syncTokens[sub.key] = lastMatch
        ? encodeSyncToken({
            updatedAt: lastMatch.updatedAt,
            revisionCount: lastMatch.revisionCount,
            recordId: lastMatch.recordId,
          })
        : sub.syncToken;
    }

    // Deduplicate patches — last write per recordId wins across subscriptions.
    const patchMap = new Map<string, SyncPatch<T>>();
    for (const p of allPatches) {
      const k = p.op === "upsert" ? p.record.recordId : p.recordId;
      patchMap.set(k, p);
    }

    return { patches: [...patchMap.values()], syncTokens };
  }

  async push(req: { records: T[] }): Promise<{ ok: true; serverUpdatedAt: number } | ConflictResult<T>> {
    const { readonlyFields, onRecordsChanged } = this.options;
    const stored: T[] = [];
    const now = Date.now();

    for (const incoming of req.records) {
      const existing = await this.store.getById(incoming.recordId);

      let record = incoming;
      if (readonlyFields && readonlyFields.length > 0 && existing) {
        const patched = { ...record } as Record<string, unknown>;
        for (const field of readonlyFields) {
          patched[field] = (existing as Record<string, unknown>)[field];
        }
        record = patched as T;
      }

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

    return { ok: true, serverUpdatedAt: now };
  }

  /**
   * Upserts a record from the server itself (background job, webhook, etc.).
   * The server's intent always wins — no conflict resolution.
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
    };

    const stored = await this.store.upsert(toStore);
    onRecordsChanged?.([stored]);
    return stored;
  }
}
