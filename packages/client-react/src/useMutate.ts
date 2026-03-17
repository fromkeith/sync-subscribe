import { useCallback, useContext } from "react";
import type { SyncRecord } from "@sync-subscribe/core";
import { SyncContext } from "./context.js";

/**
 * Returns a `mutate` function that writes a record to the local store and
 * pushes it to the server.
 *
 * When the device is **offline** the record is still written locally
 * (read-your-own-writes) and queued. The push is retried automatically
 * by `SyncProvider` when connectivity is restored.
 *
 * Returns `true` on success (or when queued offline), `false` when the
 * server rejected the push due to a conflict (server record wins).
 *
 * Always increment `revisionCount` before calling `mutate`:
 * @example
 * const mutate = useMutate<NoteRecord>();
 *
 * await mutate({
 *   ...note,
 *   title: "Updated title",
 *   updatedAt: Date.now(),
 *   revisionCount: note.revisionCount + 1,
 * });
 */
export function useMutate<T extends SyncRecord>(): (record: T) => Promise<boolean> {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useMutate must be used inside <SyncProvider>");
  const { enqueue } = ctx;

  return useCallback(
    (record: T) => enqueue(record as SyncRecord),
    [enqueue],
  );
}
