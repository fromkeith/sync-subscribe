import type Database from "better-sqlite3";
import type { SyncPatch, SyncToken, SubscriptionFilter, FilterValue } from "@sync-subscribe/core";
import { decodeSyncToken } from "@sync-subscribe/core";
import type { SyncStore } from "@sync-subscribe/server";
import type { NoteRecord } from "./types.js";

type Condition = Record<string, unknown>;

function toSqlValue(v: FilterValue): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function filterToSql(
  filter: SubscriptionFilter,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or" || key === "$and") {
      const branches = condition as SubscriptionFilter[];
      const parts = branches.map((branch) => {
        const sub = filterToSql(branch);
        params.push(...sub.params);
        return sub.clauses.length > 0
          ? `(${sub.clauses.join(" AND ")})`
          : "1=1";
      });
      const op = key === "$or" ? " OR " : " AND ";
      clauses.push(`(${parts.join(op)})`);
      continue;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid column name in filter: ${key}`);
    }

    const c = condition as Condition;

    if (condition === null || typeof condition !== "object") {
      clauses.push(`"${key}" = ?`);
      params.push(toSqlValue(condition as FilterValue));
    } else if ("$in" in c) {
      const vals = c.$in as FilterValue[];
      clauses.push(`"${key}" IN (${vals.map(() => "?").join(", ")})`);
      params.push(...vals.map(toSqlValue));
    } else if ("$nin" in c) {
      const vals = c.$nin as FilterValue[];
      clauses.push(`"${key}" NOT IN (${vals.map(() => "?").join(", ")})`);
      params.push(...vals.map(toSqlValue));
    } else if ("$gte" in c) {
      clauses.push(`"${key}" >= ?`);
      params.push(toSqlValue(c.$gte as FilterValue));
    } else if ("$gt" in c) {
      clauses.push(`"${key}" > ?`);
      params.push(toSqlValue(c.$gt as FilterValue));
    } else if ("$lte" in c) {
      clauses.push(`"${key}" <= ?`);
      params.push(toSqlValue(c.$lte as FilterValue));
    } else if ("$lt" in c) {
      clauses.push(`"${key}" < ?`);
      params.push(toSqlValue(c.$lt as FilterValue));
    } else if ("$ne" in c) {
      clauses.push(`"${key}" != ?`);
      params.push(toSqlValue(c.$ne as FilterValue));
    } else if ("$exists" in c) {
      clauses.push(c.$exists ? `"${key}" IS NOT NULL` : `"${key}" IS NULL`);
    }
  }

  return { clauses, params };
}

function rowToNote(row: Record<string, unknown>): NoteRecord {
  return {
    recordId: row["recordId"] as string,
    userId: row["userId"] as string,
    createdAt: row["createdAt"] as number,
    updatedAt: row["updatedAt"] as number,
    ...(row["serverUpdatedAt"] != null && { serverUpdatedAt: row["serverUpdatedAt"] as number }),
    revisionCount: row["revisionCount"] as number,
    color: (row["color"] as string | null) ?? null,
    category: (row["category"] as string | null) ?? null,
    isDeleted: row["isDeleted"] === 1,
    fontFamily: (row["fontFamily"] as string | null) ?? null,
    title: row["title"] as string,
    contents: row["contents"] as string,
  };
}

export class NotesStore implements SyncStore<NoteRecord> {
  constructor(private readonly db: Database.Database) {}

  async getRecordsSince(
    subscriptions: { filter: SubscriptionFilter; since: SyncToken }[],
  ): Promise<SyncPatch<NoteRecord>[]> {
    if (subscriptions.length === 0) return [];

    // Build one query using a union of all filters, each scoped to its own since-token.
    // Use the earliest (smallest) since-token to keep the query simple, then rely on
    // SyncHandler to compute per-subscription syncTokens from the returned patches.
    const allClauses: string[] = [];
    const allParams: unknown[] = [];

    for (const { filter, since } of subscriptions) {
      const token = decodeSyncToken(since);
      const { clauses, params } = filterToSql(filter);

      if (token) {
        clauses.push(`(
          "updatedAt" > ? OR
          ("updatedAt" = ? AND "revisionCount" > ?) OR
          ("updatedAt" = ? AND "revisionCount" = ? AND "recordId" > ?)
        )`);
        params.push(
          token.updatedAt,
          token.updatedAt, token.revisionCount,
          token.updatedAt, token.revisionCount, token.recordId,
        );
      }

      const subWhere = clauses.length ? clauses.join(" AND ") : "1=1";
      allClauses.push(`(${subWhere})`);
      allParams.push(...params);
    }

    const where = `WHERE ${allClauses.join(" OR ")}`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT * FROM notes ${where}
         ORDER BY "updatedAt" ASC, "revisionCount" ASC, "recordId" ASC`,
      )
      .all(allParams) as Record<string, unknown>[];

    return rows.map((row) => ({ op: "upsert", record: rowToNote(row) }));
  }

  async upsert(record: NoteRecord): Promise<NoteRecord> {
    this.db
      .prepare(
        `INSERT INTO notes
           (recordId, userId, createdAt, updatedAt, serverUpdatedAt, revisionCount,
            color, category, isDeleted, fontFamily, title, contents)
         VALUES
           (@recordId, @userId, @createdAt, @updatedAt, @serverUpdatedAt, @revisionCount,
            @color, @category, @isDeleted, @fontFamily, @title, @contents)
         ON CONFLICT(recordId) DO UPDATE SET
           updatedAt       = excluded.updatedAt,
           serverUpdatedAt = excluded.serverUpdatedAt,
           revisionCount   = excluded.revisionCount,
           color           = excluded.color,
           category        = excluded.category,
           isDeleted       = excluded.isDeleted,
           fontFamily      = excluded.fontFamily,
           title           = excluded.title,
           contents        = excluded.contents`,
      )
      .run({
        ...record,
        isDeleted: record.isDeleted ? 1 : 0,
        serverUpdatedAt: record.serverUpdatedAt ?? null,
      });
    return record;
  }

  async getById(recordId: string): Promise<NoteRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE recordId = ?")
      .get(recordId) as Record<string, unknown> | undefined;
    return row ? rowToNote(row) : null;
  }
}
