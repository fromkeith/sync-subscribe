import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncRecord, SubscriptionFilter } from "@sync-subscribe/core";
import { matchesFilter } from "@sync-subscribe/core";
import { useSyncClient } from "./context.js";

export interface UseRecordsOptions {
  filter: SubscriptionFilter;
  /**
   * How often to poll the server for new data, in milliseconds.
   * Set to 0 to disable polling (e.g. when using SSE streaming instead).
   * Default: 5000.
   */
  pollInterval?: number;
}

/**
 * Subscribe to a filtered view of synced records.
 *
 * On mount the hook registers a subscription with the server, performs an
 * initial pull, and returns the matching records from the local store. It
 * re-renders whenever the local store changes (patches applied or mutations
 * written) and polls the server on the given interval.
 *
 * When `filter` changes the old subscription is replaced with a new one
 * via `previousSubscriptionId` so the server can compute a minimal diff.
 *
 * Records are filtered client-side using `matchesFilter` from @sync-subscribe/core,
 * which correctly handles overlapping subscriptions stored in the same LocalStore.
 *
 * @example
 * const notes = useRecords<NoteRecord>({ filter: { isDeleted: false } });
 */
export function useRecords<T extends SyncRecord>(
  options: UseRecordsOptions,
): T[] {
  const { filter, pollInterval = 5000 } = options;
  const client = useSyncClient<T>();

  const [records, setRecords] = useState<T[]>([]);
  const subIdRef = useRef<string | undefined>(undefined);

  // Stable serialisation of filter — avoids re-subscribing on every render
  // when the caller passes an inline object literal.
  const filterKey = JSON.stringify(filter);

  // Always hold the latest filter in a ref so async callbacks stay current.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const refresh = useCallback(async () => {
    const all = await client.store.getAll();
    const f = filterRef.current;
    setRecords(
      all.filter((r) => matchesFilter(r as Record<string, unknown>, f)),
    );
  }, [client]);

  // Create / update the server subscription and do an initial pull.
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const sub = await client.subscribe({
        filter: filterRef.current,
        ...(subIdRef.current !== undefined && {
          previousSubscriptionId: subIdRef.current,
        }),
      });
      subIdRef.current = sub.subscriptionId;

      await client.pull();
      if (!cancelled) await refresh();
    }

    init().catch(console.error);

    return () => {
      cancelled = true;
    };
    // filterKey stands in for filter — deep-equal stable dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, client, refresh]);

  // Re-render whenever any patch lands (pull or conflict resolution).
  useEffect(() => {
    return client.onPatches(() => {
      refresh().catch(console.error);
    });
  }, [client, refresh]);

  // Polling.
  useEffect(() => {
    if (pollInterval <= 0) return;
    const timer = setInterval(() => {
      client.pull().catch(() => {});
    }, pollInterval);
    return () => clearInterval(timer);
  }, [client, pollInterval]);

  return records;
}
