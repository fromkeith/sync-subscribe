import type { SyncRecord, SyncPatch } from "@sync-subscribe/core";
import { resolveConflict } from "@sync-subscribe/core";
import type { ILocalStore } from "./types.js";

/**
 * Minimal in-memory local store.
 *
 * In a real application you may want to use IdbLocalStore (IndexedDB) for
 * persistence across page reloads. The interface is intentionally simple so
 * either implementation can be passed to SyncClient.
 */
export class LocalStore<T extends SyncRecord> implements ILocalStore<T> {
  private records = new Map<string, T>();

  /** Apply a batch of patches from the server. Returns applied patches. */
  async applyPatches(patches: SyncPatch<T>[]): Promise<SyncPatch<T>[]> {
    const applied: SyncPatch<T>[] = [];

    for (const patch of patches) {
      if (patch.op === "delete") {
        this.records.delete(patch.recordId);
        applied.push(patch);
      } else {
        const existing = this.records.get(patch.record.recordId);
        if (!existing || resolveConflict(patch.record, existing) === "a") {
          this.records.set(patch.record.recordId, patch.record);
          applied.push(patch);
        }
      }
    }

    return applied;
  }

  /**
   * Write a record locally (client mutation — read-your-own-writes).
   * Does NOT push to the server; the caller is responsible for that.
   */
  async write(record: T): Promise<void> {
    this.records.set(record.recordId, record);
  }

  async getAll(): Promise<T[]> {
    return [...this.records.values()];
  }

  async getById(recordId: string): Promise<T | undefined> {
    return this.records.get(recordId);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}
