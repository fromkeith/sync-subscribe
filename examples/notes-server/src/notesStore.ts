import type Database from "better-sqlite3";
import type { SyncPatch, SyncToken, SubscriptionFilter, FilterValue } from "@sync-subscribe/core";
import { decodeSyncToken } from "@sync-subscribe/core";
import type { SyncStore } from "@sync-subscribe/server";
import type { NoteRecord } from "./types.js";

function toSqlValue(v: FilterValue): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function filterToSql(
  filter: SubscriptionFilter
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, condition] of Object.entries(filter)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid column name in filter: ${key}`);
    }
    if (condition === null || typeof condition !== "object") {
      clauses.push(`"${key}" = ?`);
      params.push(toSqlValue(condition));
    } else if ("$gte" in condition) {
      clauses.push(`"${key}" >= ?`);
      params.push(toSqlValue(condition.$gte));
    } else if ("$gt" in condition) {
      clauses.push(`"${key}" > ?`);
      params.push(toSqlValue(condition.$gt));
    } else if ("$lte" in condition) {
      clauses.push(`"${key}" <= ?`);
      params.push(toSqlValue(condition.$lte));
    } else if ("$lt" in condition) {
      clauses.push(`"${key}" < ?`);
      params.push(toSqlValue(condition.$lt));
    } else if ("$ne" in condition) {
      clauses.push(`"${key}" != ?`);
      params.push(toSqlValue(condition.$ne));
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
    filter: SubscriptionFilter,
    since: SyncToken
  ): Promise<SyncPatch<NoteRecord>[]> {
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
        token.updatedAt, token.revisionCount, token.recordId
      );
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM notes ${where}
         ORDER BY "updatedAt" ASC, "revisionCount" ASC, "recordId" ASC`
      )
      .all(params) as Record<string, unknown>[];

    return rows.map((row) => ({ op: "upsert", record: rowToNote(row) }));
  }

  async upsert(record: NoteRecord): Promise<NoteRecord> {
    this.db
      .prepare(
        `INSERT INTO notes
           (recordId, userId, createdAt, updatedAt, revisionCount,
            color, category, isDeleted, fontFamily, title, contents)
         VALUES
           (@recordId, @userId, @createdAt, @updatedAt, @revisionCount,
            @color, @category, @isDeleted, @fontFamily, @title, @contents)
         ON CONFLICT(recordId) DO UPDATE SET
           updatedAt     = excluded.updatedAt,
           revisionCount = excluded.revisionCount,
           color         = excluded.color,
           category      = excluded.category,
           isDeleted     = excluded.isDeleted,
           fontFamily    = excluded.fontFamily,
           title         = excluded.title,
           contents      = excluded.contents`
      )
      .run({ ...record, isDeleted: record.isDeleted ? 1 : 0 });
    return record;
  }

  async getById(recordId: string): Promise<NoteRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE recordId = ?")
      .get(recordId) as Record<string, unknown> | undefined;
    return row ? rowToNote(row) : null;
  }
}
