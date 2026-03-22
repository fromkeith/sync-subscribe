import {
  type SyncRecord,
  type SyncPatch,
  type SyncToken,
  type SubscriptionFilter,
  type TableSchema,
  filtersEqual,
  filterUnion,
  negateFilter,
  simplifyFilter,
  isAlwaysFalse,
  EMPTY_SYNC_TOKEN,
} from "@sync-subscribe/core";
import type {
  ClientSubscription,
  ClientSubscriptionOptions,
  ILocalStore,
  PatchListener,
  PersistedSubscription,
  SubscriptionStatus,
  SyncTransport,
} from "./types.js";
import { InMemoryStore } from "./inMemoryStore.js";

/**
 * High-level client that manages subscriptions, local state, and sync cycles.
 *
 * Pass a custom `store` to use IndexedDB persistence:
 *   new SyncClient(transport, new IdbLocalStore("my-db"))
 *
 * Omit `store` to use the default in-memory store.
 */
export class SyncClient<T extends SyncRecord> {
  private listeners: PatchListener<T>[] = [];
  private activeSubs = new Map<string, PersistedSubscription>(); // keyed by subscriptionId
  private subActiveListeners = new Map<string, Set<() => void>>(); // keyed by subscriptionId

  private pendingPull: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  readonly store: ILocalStore<T>;

  constructor(
    private readonly transport: SyncTransport,
    store?: ILocalStore<T>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly schema?: TableSchema<T>,
  ) {
    this.store = store ?? new InMemoryStore<T>();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  /** Serial queue — subscribe() calls run one at a time to prevent races. */
  private subscribeQueue: Promise<unknown> = Promise.resolve();

  subscribe(options: ClientSubscriptionOptions): Promise<ClientSubscription> {
    const next = this.subscribeQueue.then(() => this._subscribe(options));
    // Swallow errors on the shared chain so a failure doesn't block future calls.
    this.subscribeQueue = next.catch(() => {});
    return next;
  }

  private async _subscribe(
    options: ClientSubscriptionOptions,
  ): Promise<ClientSubscription> {
    const { name } = options;
    const inputFilter = simplifyFilter(options.filter);
    let previousSubscriptionId = options.previousSubscriptionId;
    let storedSub: PersistedSubscription | undefined;

    // Restore from store if named and no explicit previousSubscriptionId
    if (name && previousSubscriptionId === undefined) {
      console.log("has name, no previousId");
      storedSub = await this.store.getSubscription(name);
      if (storedSub) {
        previousSubscriptionId = storedSub.subscriptionId;
      }
    } else if (previousSubscriptionId !== undefined) {
      console.log("has previousId");
      storedSub = await this.store.getSubscriptionById(previousSubscriptionId);
    }

    // If filter is unchanged, reuse existing subscription (restores status too)
    if (storedSub && filtersEqual(storedSub.filter, inputFilter)) {
      console.log("filter is the same!");
      const result: ClientSubscription = {
        ...storedSub,
        ...(name !== undefined && { name }),
      };
      this.activeSubs.set(result.subscriptionId, result);
      return result;
    }
    console.log("filter has changed", {
      storedSub,
      inputFilter,
    });

    // Create or update via transport
    const result = await this.transport.createSubscription(
      inputFilter,
      previousSubscriptionId,
    );

    // Clean up old subscription if replacing
    // if (storedSub) {
    //   const oldKey = storedSub.name ?? storedSub.subscriptionId;
    //   await this.store.removeSubscription(oldKey);
    //   this.activeSubs.delete(storedSub.subscriptionId);

    //   // TODO: also evict any filter changes
    //   if (result.resetRequired) {
    //     await this.store.evict(storedSub.filter as SubscriptionFilter<T>);
    //   }
    // }

    // Build new sub — status determined below
    let newSub: PersistedSubscription = {
      subscriptionId: result.subscriptionId,
      filter: result.filter,
      syncToken: result.syncToken,
      ...(name !== undefined && { name }),
      status: "active",
    };

    console.log("new sub", newSub);

    const key = name ?? result.subscriptionId;

    // Load all persisted subscriptions from the store (source of truth — activeSubs
    // only reflects the current session). Exclude the old sub being replaced, if any.
    const allPersistedSubs = await this.store.listSubscriptions();
    const existingFilters = allPersistedSubs
      .filter((s) => s.subscriptionId !== storedSub?.subscriptionId)
      .filter((s) => s.syncToken !== EMPTY_SYNC_TOKEN)
      .map((s) => s.filter as SubscriptionFilter<T>);
    console.log("existingFilters", existingFilters);

    // two things to Check
    // 1. is our new filter entirely contained in our existing data?
    // 2. does our old filter contain items that need eviction

    let newFilterPositive = existingFilters;
    let evictionFilter: SubscriptionFilter<T>[] | undefined;
    if (storedSub) {
      // need the old filter in too
      newFilterPositive = [
        ...existingFilters,
        storedSub.filter as SubscriptionFilter<T>,
      ];
      // put new input filter in
      evictionFilter = [
        ...existingFilters,
        inputFilter as SubscriptionFilter<T>,
      ];
    }

    if (newFilterPositive.length > 0) {
      newSub = await this.checkForGap(newFilterPositive, inputFilter, newSub);
    }
    if (storedSub && evictionFilter && evictionFilter.length > 0) {
      await this.checkForEviction(evictionFilter, storedSub.filter);
    }

    newSub = { ...result, ...newSub };

    await this.store.setSubscription(key, newSub);
    this.activeSubs.set(result.subscriptionId, newSub);

    return newSub;
  }

  private async checkForEviction(
    existingFilters: SubscriptionFilter<T>[],
    oldFilter: SubscriptionFilter,
  ) {
    const existingUnion = filterUnion(...existingFilters);
    console.log("checkForEviction-existingUnion", existingUnion);
    const negatedUnion = negateFilter(existingUnion);
    console.log("checkForEviction-negatedUnion", negatedUnion);

    const rawGap = {
      $and: [oldFilter, negatedUnion],
    } as SubscriptionFilter;

    if (isAlwaysFalse(rawGap)) {
      // nothing needs to be removed
      return;
    }
    const rawIntersection = {
      $and: [oldFilter, existingUnion],
    } as SubscriptionFilter;
    console.log("checkForEviction-rawIntersection", rawIntersection);
    // Gap exists — simplify the gap filter for the server (safe to do after always-false check).
    const fGap = simplifyFilter(rawGap);
    console.log("checkForEviction-fGap", fGap);
    await this.store.evict(fGap as SubscriptionFilter<T>);
  }

  /** Checks if the new inputFilter results in a gap we need to fill */
  private async checkForGap(
    existingFilters: SubscriptionFilter<T>[],
    inputFilter: SubscriptionFilter,
    newSub: PersistedSubscription,
  ): Promise<PersistedSubscription> {
    // Compute the gap: the part of F_new not covered by any existing subscription.
    // isAlwaysFalse must see the raw $and structure — simplifyFilter can destroy
    // contradictions (e.g. collapses { $and:[{x:1},{x:{$ne:1}}] } → {x:1}).
    const existingUnion = filterUnion(...existingFilters);
    console.log("existingUnion", existingUnion);
    const negatedUnion = negateFilter(existingUnion);
    console.log("negatedUnion", negatedUnion);
    const rawGap = {
      $and: [inputFilter, negatedUnion],
    } as SubscriptionFilter;
    console.log("rawGap", rawGap);

    if (isAlwaysFalse(rawGap)) {
      console.log("isAlwaysFalse");
      // F_new is fully covered — every possible record matching F_new is already
      // served by an existing subscription. Reconstruct token from local data.
      const reconstructed = await this.store.reconstructSyncToken(
        inputFilter as SubscriptionFilter<T>,
      );
      const updated: PersistedSubscription = {
        ...newSub,
        status: "active",
        syncToken:
          reconstructed !== EMPTY_SYNC_TOKEN ? reconstructed : newSub.syncToken,
      };
      return updated;
      // await this.store.setSubscription(key, updated);
      // this.activeSubs.set(result.subscriptionId, updated);
      // return { ...result, ...updated };
    }
    console.log("isnot always false");

    // Check if fNew and existing subs are completely disjoint (no overlap at all).
    // In this case there's no local data to reuse — use the server token directly.
    const rawIntersection = {
      $and: [inputFilter, existingUnion],
    } as SubscriptionFilter;
    if (isAlwaysFalse(rawIntersection)) {
      return newSub;
    }
    console.log("rawIntersection", rawIntersection);

    // Gap exists — simplify the gap filter for the server (safe to do after always-false check).
    const fGap = simplifyFilter(rawGap);

    console.log("fGap", fGap);
    const gapResult = await this.transport.createSubscription(fGap);
    const gapSub: PersistedSubscription = {
      subscriptionId: gapResult.subscriptionId,
      filter: gapResult.filter,
      syncToken: EMPTY_SYNC_TOKEN,
      status: "active", // gap sub itself is always "active" in the pull
    };
    // Store gap sub keyed by its own subscriptionId (unnamed)
    await this.store.setSubscription(gapResult.subscriptionId, gapSub);
    const pendingSub: PersistedSubscription = {
      ...newSub,
      status: "pending_gap_fill",
      gapSubscriptionId: gapResult.subscriptionId,
    };
    return pendingSub;
  }

  /**
   * Update an existing subscription to use a new filter.
   * Delegates to subscribe() with previousSubscriptionId set.
   */
  async updateSubscription(
    subscriptionId: string,
    newFilter: SubscriptionFilter,
  ): Promise<ClientSubscription> {
    const existing =
      this.activeSubs.get(subscriptionId) ??
      (await this.store.getSubscriptionById(subscriptionId));
    if (!existing) throw new Error(`Unknown subscription: ${subscriptionId}`);

    return this.subscribe({
      filter: newFilter,
      previousSubscriptionId: subscriptionId,
      ...(existing.name !== undefined && { name: existing.name }),
    });
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Pull patches for all subscriptions.
   * - ACTIVE subscriptions are included directly.
   * - PENDING subscriptions are excluded; their gap sub is included instead.
   * When a gap sub's token appears in the response the gap is complete:
   * the gap sub is removed, the parent subscription reconstructs its token
   * and transitions to active.
   */
  async pull(): Promise<void> {
    const subsForPull: { id: string; syncToken: SyncToken }[] = [];
    // Maps gapSubId → parentSubId so we can detect gap completion
    const gapSubToParent = new Map<string, string>();

    for (const sub of this.activeSubs.values()) {
      const status = sub.status ?? "active";
      if (status === "active") {
        subsForPull.push({ id: sub.subscriptionId, syncToken: sub.syncToken });
      } else if (status === "pending_gap_fill" && sub.gapSubscriptionId) {
        const gapSub = await this.store.getSubscriptionById(
          sub.gapSubscriptionId,
        );
        if (gapSub) {
          subsForPull.push({
            id: gapSub.subscriptionId,
            syncToken: gapSub.syncToken,
          });
          gapSubToParent.set(gapSub.subscriptionId, sub.subscriptionId);
        }
      }
    }

    if (subsForPull.length === 0) return;

    const { patches, syncTokens } = await this.transport.pull(subsForPull);
    const applied = await this.store.applyPatches(patches as SyncPatch<T>[]);

    for (const [id, syncToken] of Object.entries(syncTokens)) {
      const parentSubId = gapSubToParent.get(id);

      if (parentSubId) {
        // Gap sub received a response — gap is filled.
        const parentSub = this.activeSubs.get(parentSubId)!;

        // Remove gap sub from server (best-effort) and local store
        await this.transport.deleteSubscription?.(id).catch(() => {});
        await this.store.removeSubscription(id);

        // Reconstruct the parent's sync token from the now-complete local data
        const reconstructed = await this.store.reconstructSyncToken(
          parentSub.filter as SubscriptionFilter<T>,
        );

        const activeSub: PersistedSubscription = {
          ...parentSub,
          status: "active" as SubscriptionStatus,
          syncToken:
            reconstructed !== EMPTY_SYNC_TOKEN
              ? reconstructed
              : parentSub.syncToken,
        };
        delete (activeSub as Partial<PersistedSubscription>).gapSubscriptionId;

        const key = parentSub.name ?? parentSub.subscriptionId;
        await this.store.setSubscription(key, activeSub);
        this.activeSubs.set(parentSubId, activeSub);

        this._emitSubscriptionActive(parentSubId);
      } else {
        // Normal active sub — update its token
        const sub = this.activeSubs.get(id);
        if (sub) {
          const updated = { ...sub, syncToken };
          const key = sub.name ?? sub.subscriptionId;
          await this.store.setSubscription(key, updated);
          this.activeSubs.set(id, updated);
        }
      }
    }

    if (applied.length > 0) this.emit(applied);
  }

  /**
   * Debounced pull — collapses multiple rapid calls (e.g. several hooks mounting
   * at the same time) into a single transport request. All callers share the same
   * promise and receive the result of the one batched pull.
   *
   * @param delayMs - How long to wait before issuing the pull (default 20 ms).
   */
  schedulePull(delayMs = 20): Promise<void> {
    if (this.pendingPull) {
      clearTimeout(this.pendingPull.timer);
      this.pendingPull.timer = setTimeout(() => this._flushPull(), delayMs);
      return this.pendingPull.promise;
    }

    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => this._flushPull(), delayMs);
    this.pendingPull = { promise, resolve, reject, timer };
    return promise;
  }

  private async _flushPull(): Promise<void> {
    const pending = this.pendingPull;
    this.pendingPull = null;
    if (!pending) return;
    try {
      await this.pull();
      pending.resolve();
    } catch (err) {
      pending.reject(err);
    }
  }

  /**
   * Write a record locally (read-your-own-writes) then push to server.
   * Returns true on success, false if a conflict was detected (server wins).
   */
  async mutate(record: T): Promise<boolean> {
    await this.store.write(record);
    // Optimistic update — notify listeners immediately so the UI reflects the change.
    this.emit([{ op: "upsert", record }]);

    const result = await this.transport.push([record]);

    if ("conflict" in result && result.conflict) {
      // Server wins: overwrite local record with server version.
      const applied = await this.store.applyPatches([
        { op: "upsert", record: result.serverRecord as T },
      ]);
      if (applied.length > 0) this.emit(applied);
      return false;
    }

    // Stamp serverUpdatedAt on the local copy so reconstructSyncToken stays accurate.
    // Emit again so listeners see the final record with serverUpdatedAt set.
    const serverUpdatedAt = (result as { ok: true; serverUpdatedAt?: number })
      .serverUpdatedAt;
    if (serverUpdatedAt !== undefined) {
      await this.store.setServerUpdatedAt(record.recordId, serverUpdatedAt);
      const updated = await this.store.getById(record.recordId);
      if (updated) this.emit([{ op: "upsert", record: updated }]);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  /**
   * Open a single SSE stream for all ACTIVE subscriptions.
   * PENDING subscriptions (awaiting gap fill) are excluded until they transition.
   * Returns a cleanup function — call it to close the connection.
   */
  stream(): () => void {
    if (!this.transport.stream) {
      throw new Error(
        "Transport does not support streaming — implement transport.stream()",
      );
    }

    const subs = [...this.activeSubs.values()].filter(
      (s) => (s.status ?? "active") === "active",
    );
    if (subs.length === 0) return () => {};

    return this.transport.stream(
      subs.map((s) => ({ id: s.subscriptionId, syncToken: s.syncToken })),
      async ({ patches, syncTokens }) => {
        const applied = await this.store.applyPatches(
          patches as SyncPatch<T>[],
        );

        for (const [id, syncToken] of Object.entries(syncTokens)) {
          const sub = this.activeSubs.get(id);
          if (sub) {
            const updated = { ...sub, syncToken };
            const key = sub.name ?? sub.subscriptionId;
            await this.store.setSubscription(key, updated);
            this.activeSubs.set(id, updated);
          }
        }

        if (applied.length > 0) this.emit(applied);
      },
      (err) => console.error("[SyncClient] SSE error:", err),
    );
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

  /**
   * Register a one-shot listener that fires when the given subscription
   * transitions from pending_gap_fill → active. Useful for restarting the
   * SSE stream to include the newly-active subscription.
   * Returns an unsubscribe function.
   */
  onSubscriptionActive(
    subscriptionId: string,
    listener: () => void,
  ): () => void {
    if (!this.subActiveListeners.has(subscriptionId)) {
      this.subActiveListeners.set(subscriptionId, new Set());
    }
    this.subActiveListeners.get(subscriptionId)!.add(listener);
    return () => {
      this.subActiveListeners.get(subscriptionId)?.delete(listener);
    };
  }

  private _emitSubscriptionActive(subscriptionId: string): void {
    const listeners = this.subActiveListeners.get(subscriptionId);
    if (listeners) {
      for (const l of listeners) l();
      this.subActiveListeners.delete(subscriptionId);
    }
  }

  private emit(patches: SyncPatch<T>[]): void {
    for (const l of this.listeners) l(patches);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Look up a subscription by name (for named subs) or by subscriptionId
   * (for unnamed subs, where the key IS the subscriptionId).
   */
  getSubscription(key: string): ClientSubscription | undefined {
    // Try by subscriptionId first (covers unnamed subs)
    const byId = this.activeSubs.get(key);
    if (byId) return byId as ClientSubscription;
    // Then by name (covers named subs)
    for (const sub of this.activeSubs.values()) {
      if (sub.name === key) return sub as ClientSubscription;
    }
    return undefined;
  }

  getSubscriptionById(id: string): ClientSubscription | undefined {
    return this.activeSubs.get(id) as ClientSubscription | undefined;
  }

  /** Resets sync state (useful for logout / account switch). */
  async reset(): Promise<void> {
    this.activeSubs.clear();
    await this.store.clear();
    await this.store.clearSubscriptions();
  }
}
