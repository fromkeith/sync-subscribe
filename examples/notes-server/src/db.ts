import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { NoteRecord } from "./types.js";

export function openDb(path = "notes.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      subscriptionId TEXT PRIMARY KEY,
      clientFilter   TEXT NOT NULL,
      serverFilter   TEXT NOT NULL,
      filter         TEXT NOT NULL,
      syncToken      TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      recordId    TEXT PRIMARY KEY,
      userId      TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL,
      revisionCount INTEGER NOT NULL DEFAULT 1,
      color       TEXT,
      category    TEXT,
      isDeleted   INTEGER NOT NULL DEFAULT 0,
      fontFamily  TEXT,
      title       TEXT NOT NULL DEFAULT '',
      contents    TEXT NOT NULL DEFAULT ''
    );
  `);

  // Seed data if the table is empty
  const count = (db.prepare("SELECT COUNT(*) as n FROM notes").get() as { n: number }).n;
  if (count === 0) {
    seedNotes(db);
  }

  return db;
}

function seedNotes(db: Database.Database) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const seeds: NoteRecord[] = [
    {
      recordId: randomUUID(),
      userId: "user-123",
      createdAt: now - 5 * day,
      updatedAt: now - 5 * day,
      revisionCount: 1,
      color: "blue",
      category: "work",
      isDeleted: false,
      fontFamily: "sans-serif",
      title: "Sprint planning",
      contents: "Review backlog and assign story points for next sprint.",
    },
    {
      recordId: randomUUID(),
      userId: "user-123",
      createdAt: now - 2 * day,
      updatedAt: now - 2 * day,
      revisionCount: 2,
      color: "green",
      category: "personal",
      isDeleted: false,
      fontFamily: "serif",
      title: "Grocery list",
      contents: "Milk, eggs, bread, oat milk, spinach.",
    },
    {
      recordId: randomUUID(),
      userId: "user-123",
      createdAt: now - 40 * day,
      updatedAt: now - 40 * day,
      revisionCount: 1,
      color: "yellow",
      category: "ideas",
      isDeleted: false,
      fontFamily: null,
      title: "Old idea (>30 days)",
      contents: "This note is older than 30 days and won't appear in the recent subscription.",
    },
    {
      recordId: randomUUID(),
      userId: "user-123",
      createdAt: now - 1 * day,
      updatedAt: now - 1 * day,
      revisionCount: 1,
      color: "blue",
      category: "work",
      isDeleted: false,
      fontFamily: "monospace",
      title: "API design notes",
      contents: "Consider using SSE for real-time sync. Evaluate WebSocket tradeoffs.",
    },
    {
      recordId: randomUUID(),
      userId: "user-123",
      createdAt: now - 10 * day,
      updatedAt: now - 10 * day,
      revisionCount: 1,
      color: "purple",
      category: "reading",
      isDeleted: false,
      fontFamily: null,
      title: "Book notes: DDIA",
      contents: "Chapter 5 on replication — single-leader vs multi-leader tradeoffs.",
    },
    {
      recordId: randomUUID(),
      userId: "user-456", // different user — should not appear for user-123
      createdAt: now - 1 * day,
      updatedAt: now - 1 * day,
      revisionCount: 1,
      color: "blue",
      category: "private",
      isDeleted: false,
      fontFamily: null,
      title: "User 456's note",
      contents: "This should never be visible to user-123 due to server-side filter.",
    },
  ];

  const stmt = db.prepare(`
    INSERT INTO notes (recordId, userId, createdAt, updatedAt, revisionCount,
      color, category, isDeleted, fontFamily, title, contents)
    VALUES (@recordId, @userId, @createdAt, @updatedAt, @revisionCount,
      @color, @category, @isDeleted, @fontFamily, @title, @contents)
  `);

  for (const note of seeds) {
    stmt.run({ ...note, isDeleted: note.isDeleted ? 1 : 0 });
  }
}
