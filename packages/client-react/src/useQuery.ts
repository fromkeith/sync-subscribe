import { useEffect, useState } from "react";
import type { SyncRecord } from "@sync-subscribe/core";
import type { SyncQuery } from "@sync-subscribe/client";

/**
 * Subscribes to a `SyncQuery` and returns its current `{ data, loading }` state.
 *
 * The `syncQuery` reference must be stable across renders — create it with
 * `useMemo` or at module level, otherwise it will re-subscribe on every render.
 *
 * Works with both `client.query()` (local-store only) and `client.liveQuery()`
 * (sync + query combined).
 *
 * @example
 * // Local-only query (data already synced elsewhere)
 * const q = useMemo(() => client.query({ filter: { isDeleted: false } }), [client]);
 * const { data, loading } = useQuery(q);
 *
 * @example
 * // Live query — manages its own sync subscription
 * const q = useMemo(() => client.liveQuery({ filter: { isDeleted: false } }), [client]);
 * const { data, loading } = useQuery(q);
 */
export function useQuery<T extends SyncRecord>(
  syncQuery: SyncQuery<T>,
): { data: T[]; loading: boolean } {
  const [state, setState] = useState<{ data: T[]; loading: boolean }>({
    data: [],
    loading: true,
  });

  useEffect(() => {
    return syncQuery.subscribe((value) => setState(value));
  }, [syncQuery]);

  return state;
}
