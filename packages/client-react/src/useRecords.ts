import { useMemo } from "react";
import type { SyncRecord, SubscriptionFilter } from "@sync-subscribe/core";
import { useSyncClient } from "./context.js";
import { useQuery } from "./useQuery.js";

export interface UseRecordsOptions<T extends SyncRecord = SyncRecord> {
  filter: SubscriptionFilter<T>;
  /**
   * Stable name for this subscription. When provided, the subscription state
   * is persisted to the local store and automatically restored on next startup,
   * enabling incremental sync instead of a full re-fetch.
   */
  name?: string;
}

/**
 * Sync-and-query shorthand. Registers a live sync subscription for `filter`
 * and returns its records as `{ data, loading }`.
 *
 * `loading` is `true` until the first pull completes.
 * The sync subscription is automatically removed when the component unmounts.
 *
 * For a narrower in-memory view over a broader background sync (e.g. showing
 * 1 day of data while syncing 30 days), use `useQuery` with `client.query()`
 * instead — it reads from the local store without registering a new subscription.
 *
 * @example
 * const { data: notes, loading } = useRecords<NoteRecord>({
 *   filter: { isDeleted: false },
 *   name: "active-notes",
 * });
 */
export function useRecords<T extends SyncRecord>(
  options: UseRecordsOptions<T>,
): { data: T[]; loading: boolean } {
  const client = useSyncClient<T>();
  // Stringify the filter so object literals don't cause a new liveQuery on every render.
  const filterKey = JSON.stringify(options.filter);

  const liveQuery = useMemo(
    () => client.liveQuery({
      filter: options.filter,
      ...(options.name !== undefined && { name: options.name }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, filterKey, options.name],
  );

  return useQuery(liveQuery);
}
