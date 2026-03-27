# @sync-subscribe/client-svelte

Svelte 5 bindings for `@sync-subscribe/client`. Uses [svelteprovider](https://www.npmjs.com/package/svelteprovider) to expose the sync client and reactive queries as composable providers that work natively with Svelte's rune system.

## Installation

```bash
npm install @sync-subscribe/client-svelte @sync-subscribe/client @sync-subscribe/core
```

Svelte ≥ 5 is a peer dependency.

## Quick start

### 1. Create providers (module level, outside components)

```ts
// providers.ts
import { IdbLocalStore, createFetchTransport } from "@sync-subscribe/client";
import { createSyncClientProvider, createLiveQuery, createQuery } from "@sync-subscribe/client-svelte";
import type { NoteRecord } from "./types.js";

const transport = createFetchTransport({ baseUrl: "/api" });
const store     = new IdbLocalStore<NoteRecord>("notes-db");

// One clientProvider per record type
export const clientProvider = createSyncClientProvider<NoteRecord>(transport, store);

// Separate factory per independent query — each factory is a singleton provider
export const notesLiveQuery = createLiveQuery<NoteRecord>(clientProvider());
export const notesCachedQuery = createQuery<NoteRecord>(clientProvider());

export async function mutate(record: NoteRecord) {
  const client = await clientProvider().promise;
  return client.mutate(record);
}
```

### 2. Subscribe in a component

```svelte
<script lang="ts">
  import { notesLiveQuery, mutate } from "./providers.js";
  import type { NoteRecord } from "./types.js";

  let notes  = $state<NoteRecord[]>([]);
  let loading = $state(true);

  $effect(() => {
    // Re-runs when the filter changes; cleanup (unsub) is automatic
    return notesLiveQuery({ filter: { isDeleted: false } }).subscribe((value) => {
      if (value) {
        notes   = value.data;
        loading = value.loading;
      }
    });
  });

  async function handleDelete(note: NoteRecord) {
    await mutate({ ...note, isDeleted: true });
  }
</script>

{#if loading}
  <p>Loading…</p>
{:else}
  {#each notes as note (note.recordId)}
    <div>{note.title} <button onclick={() => handleDelete(note)}>Delete</button></div>
  {/each}
{/if}
```

## API

### `createSyncClientProvider<T>(transport, store, schema?)`

Returns a **provider factory**. Call the factory once to get the singleton provider:

```ts
const clientProvider = createSyncClientProvider<NoteRecord>(transport, store, schema);
const provider = clientProvider(); // singleton — always returns the same instance
const client   = await provider.promise; // resolves to SyncClient<NoteRecord>
```

### `createLiveQuery<T>(clientProvider)`

Returns a **paramProvider factory**. Each factory is a singleton — calling it with new options updates the active query in place. Create **one factory per independent query** to avoid conflicts:

```ts
const notesQuery = createLiveQuery<NoteRecord>(clientProvider());
// In a component:
const unsub = notesQuery({ filter: { isDeleted: false } }).subscribe(({ data, loading }) => {
  // ...
});
```

The returned provider also exposes `mutate`:

```ts
await notesQuery({ filter: {} }).mutate(record);
```

### `createQuery<T>(clientProvider)`

Same as `createLiveQuery` but uses `client.query()` instead of `client.liveQuery()`. No sync subscription is registered — use this when data is already being synced by a separate background subscription.

## Pattern: background sync window + narrow display query

```ts
// providers.ts
export const backgroundSync = createSyncClientProvider<NoteRecord>(transport, store);
export const recentQuery    = createQuery<NoteRecord>(backgroundSync());     // local-store only
export const liveQuery      = createLiveQuery<NoteRecord>(backgroundSync()); // registers sync sub
```

```svelte
<script lang="ts">
  import { backgroundSync, recentQuery, liveQuery } from "./providers.js";

  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  // Keep 7 days in the local store without displaying them
  $effect(() => {
    let subId: string | undefined;
    backgroundSync().promise.then(async (client) => {
      const sub = await client.subscribe({
        filter: { createdAt: { $gte: Date.now() - SEVEN_DAYS } },
        name: "bg-7d",
      });
      subId = sub.subscriptionId;
    });
    return () => {
      if (subId) backgroundSync().promise.then((c) => c.unsubscribe(subId!));
    };
  });

  let notes   = $state([]);
  let loading = $state(true);
  let range   = $state("1w"); // "1w" | "all"

  // Within window → local query only; beyond → live query with its own sync sub
  $effect(() => {
    const withinWindow = range === "1w";
    const filter = withinWindow
      ? { createdAt: { $gte: Date.now() - SEVEN_DAYS } }
      : {};
    const q = withinWindow ? recentQuery({ filter }) : liveQuery({ filter });
    return q.subscribe((v) => { if (v) { notes = v.data; loading = v.loading; } });
  });
</script>
```
