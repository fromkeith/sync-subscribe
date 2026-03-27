import { IdbLocalStore } from "@sync-subscribe/client";
import { createSyncClientProvider, createLiveQuery, createQuery } from "@sync-subscribe/client-svelte";
import type { NoteRecord } from "./types.js";
import { noteSchema } from "./types.js";
import { transport } from "./transport.js";

const localStore = new IdbLocalStore<NoteRecord>("notes");

export const clientProviderFactory = createSyncClientProvider<NoteRecord>(
  transport,
  localStore,
  noteSchema,
);

// Each independent query needs its own factory — paramProvider is a singleton
// per factory, and calling it with new options updates the shared provider in place.
export const recentQueryFactory = createQuery<NoteRecord>(clientProviderFactory());
export const recentLiveQueryFactory = createLiveQuery<NoteRecord>(clientProviderFactory());
export const blueNotesFactory = createLiveQuery<NoteRecord>(clientProviderFactory());

export async function mutate(record: NoteRecord): Promise<void> {
  const client = await clientProviderFactory().promise;
  await client.mutate(record);
}
