import type { SyncRecord, SyncPatch, SyncToken, SubscriptionFilter } from "@sync-subscribe/core";
import { resolveConflict, matchesFilter } from "@sync-subscribe/core";
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
   * Conflict resolution mirrors LocalStore: server patch wins only when its
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
              store.put(patch.record);
              applied.push(patch);
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

  async setSubscription(name: string, sub: PersistedSubscription): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put(sub, `subscription:${name}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getSubscription(name: string): Promise<PersistedSubscription | undefined> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const req = tx.objectStore("meta").get(`subscription:${name}`);
      req.onsuccess = () => resolve(req.result as PersistedSubscription | undefined);
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

  async evict(evictFilter: SubscriptionFilter, retainFilters: SubscriptionFilter[]): Promise<void> {
    const all = await this.getAll();
    const toDelete = all.filter(
      (record) =>
        matchesFilter(record as Record<string, unknown>, evictFilter) &&
        !retainFilters.some((f) => matchesFilter(record as Record<string, unknown>, f)),
    );

    if (toDelete.length === 0) return;

    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      for (const record of toDelete) {
        store.delete(record.recordId);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
