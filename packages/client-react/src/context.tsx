import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode } from "react";
import type { SyncRecord } from "@sync-subscribe/core";
import type { SyncClient } from "@sync-subscribe/client";

export interface SyncContextValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SyncClient<any>;
  /**
   * Enqueue a mutation. If the device is online the record is pushed to the
   * server immediately via client.mutate(). If offline, the record is written
   * to the local store for read-your-own-writes and queued; it will be pushed
   * automatically when connectivity is restored.
   */
  enqueue: (record: SyncRecord) => Promise<boolean>;
}

export const SyncContext = createContext<SyncContextValue | null>(null);

export interface SyncProviderProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SyncClient<any>;
  children: ReactNode;
}

/**
 * Provides a SyncClient to all child hooks.
 * Place this once near the root of your app.
 *
 * The provider also manages the offline mutation queue:
 * mutations made while the device is offline are held in memory and
 * automatically replayed (in order, deduplicated by recordId) when
 * connectivity resumes.
 */
export function SyncProvider({ client, children }: SyncProviderProps) {
  // Map<recordId, record> — only the latest mutation per record is kept.
  const queue = useRef(new Map<string, SyncRecord>());

  // Drain pending mutations when connectivity is restored.
  useEffect(() => {
    async function drain() {
      if (queue.current.size === 0) return;
      const pending = [...queue.current.values()];
      queue.current.clear();
      for (const record of pending) {
        await client.mutate(record).catch(() => {
          // Push still failing — re-queue so we retry on the next online event.
          queue.current.set(record.recordId, record);
        });
      }
    }

    const isWindow = typeof window !== "undefined";
    if (isWindow) window.addEventListener("online", drain);
    return () => {
      if (isWindow) window.removeEventListener("online", drain);
    };
  }, [client]);

  const enqueue = useCallback(
    async (record: SyncRecord): Promise<boolean> => {
      const online =
        typeof navigator === "undefined" ? true : navigator.onLine;

      if (online) {
        return client.mutate(record);
      }

      // Offline path: queue the raw record. mutate() will stamp on drain.
      queue.current.set(record.recordId, record);
      return true; // optimistic — push will happen when back online
    },
    [client],
  );

  const value = useMemo(() => ({ client, enqueue }), [client, enqueue]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/**
 * Returns the SyncClient from the nearest SyncProvider.
 * The generic parameter lets you recover the typed client at the call site.
 */
export function useSyncClient<
  T extends SyncRecord = SyncRecord,
>(): SyncClient<T> {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSyncClient must be used inside <SyncProvider>");
  return ctx.client as SyncClient<T>;
}
