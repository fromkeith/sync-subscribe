import type { ZodObject, ZodRawShape } from "zod";
import type { SyncRecord } from "./types.js";

/**
 * Describes the shape of a single table managed by SyncClient.
 *
 * @example
 * const noteSchema: TableSchema<NoteRecord> = {
 *   schema: z.object({ recordId: z.string(), title: z.string(), ... }),
 *   tableName: "notes",
 *   recordId: "recordId",
 *   indexes: [["userId"], ["isDeleted"], ["updatedAt"]],
 * };
 */
export interface TableSchema<T extends SyncRecord> {
  /**
   * Zod object schema for the record. Provides runtime validation and
   * TypeScript type inference for T.
   */
  schema: ZodObject<ZodRawShape>;

  /**
   * Logical table name — used in HTTP paths and local store namespacing.
   */
  tableName: string;

  /**
   * Maps a record to its canonical `recordId` string.
   * Use a key name (e.g. `"id"`) when the primary key column has a different
   * name, or a function for compound keys (e.g. `r => \`${r.userId}:${r.noteId}\``).
   */
  recordId: keyof T | ((record: T) => string);

  /**
   * Recommended local store indexes, expressed as arrays of field names.
   * Each inner array is one compound index.
   *
   * @example [["userId"], ["isDeleted", "updatedAt"]]
   */
  indexes?: (keyof T)[][];

  /**
   * Schema migration functions keyed by target version number.
   * Each function receives the raw stored object and returns the migrated
   * record. Migrations must NOT modify `updatedAt` or `revisionCount`.
   *
   * @example
   * migrations: {
   *   2: (r) => ({ ...(r as NoteRecord), category: (r as NoteRecord).category ?? "general" }),
   * }
   */
  migrations?: Record<number, (record: unknown) => unknown>;
}
