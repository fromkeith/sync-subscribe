import { useCallback, useContext } from "react";
import type { SyncRecord } from "@sync-subscribe/core";
import { SyncContext } from "./context.js";

/**
 * Returns a `mutate` function that writes a record to the local store and
 * pushes it to the server.
 *
 * `mutate` automatically stamps `updatedAt` and increments `revisionCount` —
 * callers should not set those fields.
 *
 * When the device is **offline** the mutation is queued and replayed
 * automatically by `SyncProvider` when connectivity is restored.
 *
 * Returns `true` on success (or when queued offline), `false` when the
 * server rejected the push due to a conflict (server record wins).
 *
 * @example
 * const mutate = useMutate<NoteRecord>();
 *
 * await mutate({ ...note, title: "Updated title" });
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
