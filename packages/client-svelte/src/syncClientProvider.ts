import {
  type ILocalStore,
  SyncClient,
  type SyncTransport,
} from "@sync-subscribe/client";
import type { SyncRecord, TableSchema } from "@sync-subscribe/core";
import { provider } from "svelteprovider";

export function createSyncClientProvider<T extends SyncRecord>(
  transport: SyncTransport,
  store: ILocalStore<T>,
  schema?: TableSchema<T>,
) {
  return provider(async () => {
    return new SyncClient<T>(transport, store, schema);
  });
}
