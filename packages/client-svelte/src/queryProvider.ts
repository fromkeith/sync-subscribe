import { type Readable } from "svelte/store";
import { provider, paramProvider } from "svelteprovider";
import type { SyncRecord, SubscriptionFilter } from "@sync-subscribe/core";
import type { Provider } from "svelteprovider";
import type { SyncClient, SyncQuery } from "@sync-subscribe/client";

export interface CreateRecordsOptions<T extends SyncRecord = SyncRecord> {
  filter: SubscriptionFilter<T>;
  name?: string;
}

/**
 * Returns a paramProvider scoped to a specific record type.
 *
 * @example
 * // module level
 * const notesProvider = createLiveQuery<NoteRecord>();
 *
 * // inside a component <script>
 * let { filter } = $props();
 * const notes = $derived(notesProvider({ filter }));
 */
export function createLiveQuery<T extends SyncRecord>(
  clientProvider: () => Provider<SyncClient<T>>,
) {
  return paramProvider((options: Readable<CreateRecordsOptions<T>>) => {
    return provider([options, clientProvider], {
      build(
        opts: CreateRecordsOptions<T>,
        client: SyncClient<T>,
      ): SyncQuery<T> {
        return client.liveQuery(opts);
      },
      async mutate(record: T) {
        const client = await clientProvider().promise;
        return client.mutate(record);
      },
    });
  });
}

export type LiveQueryProvider<T extends SyncRecord> = ReturnType<
  typeof createLiveQuery<T>
>;

/**
 * Returns a paramProvider scoped to a specific record type.
 *
 * @example
 * // module level
 * const notesProvider = createLiveQuery<NoteRecord>();
 *
 * // inside a component <script>
 * let { filter } = $props();
 * const notes = $derived(notesProvider({ filter }));
 */
export function createQuery<T extends SyncRecord>(
  clientProvider: () => Provider<SyncClient<T>>,
) {
  return paramProvider((options: Readable<CreateRecordsOptions<T>>) => {
    return provider([options, clientProvider], {
      build(
        opts: CreateRecordsOptions<T>,
        client: SyncClient<T>,
      ): SyncQuery<T> {
        return client.query(opts);
      },
      async mutate(record: T) {
        const client = await clientProvider().promise;
        return client.mutate(record);
      },
    });
  });
}

export type QueryProvider<T extends SyncRecord> = ReturnType<
  typeof createQuery<T>
>;
