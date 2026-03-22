import type {
  SyncRecord,
  SyncPatch,
  SyncToken,
  SubscriptionFilter,
} from "@sync-subscribe/core";
import {
  resolveConflict,
  matchesFilter,
  encodeSyncToken,
  EMPTY_SYNC_TOKEN,
} from "@sync-subscribe/core";
import type { ILocalStore, PersistedSubscription } from "./types.js";

/**
 * IndexedDB-backed local store. Records survive page reloads.
 *
 * Pass a unique `dbName` per logical collection (or per user if you need
 * data isolation on the same origin).
 *
 * Usage:
 *   const store = new IdbLocalStore<NoteRecord>("notes-db");
 *   const client = new SyncClient(transport, store);
 */
export class IdbLocalStore<T extends SyncRecord> implements ILocalStore<T> {
  private db: IDBDatabase | null = null;

  constructor(
    private readonly dbName: string,
    private readonly storeName: string = "records",
  ) {}

  private getDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 2);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "recordId" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta");
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        resolve(req.result);
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Apply a batch of patches inside a single readwrite transaction.
   * Copies `record.updatedAt` into `record.serverUpdatedAt` on upsert (server clock is authoritative).
   * Conflict resolution mirrors InMemoryStore: server patch wins only when its
   * revisionCount is higher (or equal with an older updatedAt).
   */
  async applyPatches(patches: SyncPatch<T>[]): Promise<SyncPatch<T>[]> {
    if (patches.length === 0) return [];

    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const applied: SyncPatch<T>[] = [];
      let pending = patches.length;

      function onPatchDone() {
        if (--pending === 0) tx.commit?.();
      }

      for (const patch of patches) {
        if (patch.op === "delete") {
          const req = store.delete(patch.recordId);
          req.onsuccess = () => {
            applied.push(patch);
            onPatchDone();
          };
          req.onerror = () => onPatchDone();
        } else {
          const getReq = store.get(patch.record.recordId);
          getReq.onsuccess = () => {
            const existing = getReq.result as T | undefined;
            if (!existing || resolveConflict(patch.record, existing) === "a") {
              // Stamp serverUpdatedAt from the server's updatedAt
              const withServerTs: T = {
                ...patch.record,
                serverUpdatedAt: patch.record.updatedAt,
              };
              store.put(withServerTs);
              applied.push({ op: "upsert", record: withServerTs });
            }
            onPatchDone();
          };
          getReq.onerror = () => onPatchDone();
        }
      }

      tx.oncomplete = () => resolve(applied);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async write(record: T): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAll(): Promise<T[]> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  }

  async query(filter: SubscriptionFilter): Promise<T[]> {
    const all = await this.getAll();
    return all.filter((r) =>
      matchesFilter(r as Record<string, unknown>, filter),
    );
  }

  async count(filter: SubscriptionFilter): Promise<number> {
    return (await this.query(filter)).length;
  }

  async getById(recordId: string): Promise<T | undefined> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).get(recordId);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(filter: SubscriptionFilter): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const req = store.openCursor();

      let deleted = 0;

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          if (deleted > 0) console.log(`[IdbLocalStore] evicted ${deleted} records`);
          return;
        }
        if (matchesFilter(cursor.value as Record<string, unknown>, filter)) {
          cursor.delete();
          deleted++;
        }
        cursor.continue();
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async evict(evictFilter: SubscriptionFilter): Promise<void> {
    return this.delete(evictFilter);
  }

  async reconstructSyncToken(
    filter: SubscriptionFilter<T>,
  ): Promise<SyncToken> {
    const all = await this.getAll();
    let best: T | undefined;

    for (const record of all) {
      if (record.serverUpdatedAt === undefined) continue;
      if (!matchesFilter(record as Record<string, unknown>, filter)) continue;

      if (
        !best ||
        record.serverUpdatedAt > best.serverUpdatedAt! ||
        (record.serverUpdatedAt === best.serverUpdatedAt &&
          record.revisionCount > best.revisionCount) ||
        (record.serverUpdatedAt === best.serverUpdatedAt &&
          record.revisionCount === best.revisionCount &&
          record.recordId > best.recordId)
      ) {
        best = record;
      }
    }

    if (!best || best.serverUpdatedAt === undefined) return EMPTY_SYNC_TOKEN;

    return encodeSyncToken({
      updatedAt: best.serverUpdatedAt,
      revisionCount: best.revisionCount,
      recordId: best.recordId,
    });
  }

  async setServerUpdatedAt(
    recordId: string,
    serverUpdatedAt: number,
  ): Promise<void> {
    const record = await this.getById(recordId);
    if (record) {
      await this.write({ ...record, serverUpdatedAt });
    }
  }

  async setSyncToken(subscriptionId: string, token: SyncToken): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put(token, `syncToken:${subscriptionId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getSyncToken(subscriptionId: string): Promise<SyncToken | undefined> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const req = tx.objectStore("meta").get(`syncToken:${subscriptionId}`);
      req.onsuccess = () => resolve(req.result as SyncToken | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async setSubscription(
    name: string,
    sub: PersistedSubscription,
  ): Promise<void> {
    if (sub.filter === undefined) {
      throw new Error("Missing filter");
    }
    if (sub.syncToken === undefined) {
      throw new Error("Missing syncToken");
    }
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put(sub, `subscription:${name}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getSubscription(
    name: string,
  ): Promise<PersistedSubscription | undefined> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const req = tx.objectStore("meta").get(`subscription:${name}`);
      req.onsuccess = () =>
        resolve(req.result as PersistedSubscription | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async getSubscriptionById(
    id: string,
  ): Promise<PersistedSubscription | undefined> {
    const subs = await this.listSubscriptions();
    return subs.find((s) => s.subscriptionId === id);
  }

  async listSubscriptions(): Promise<PersistedSubscription[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const store = tx.objectStore("meta");
      const subs: PersistedSubscription[] = [];
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (String(cursor.key).startsWith("subscription:")) {
            subs.push(cursor.value as PersistedSubscription);
          }
          cursor.continue();
        } else {
          resolve(subs);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async removeSubscription(name: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").delete(`subscription:${name}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearSubscriptions(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
