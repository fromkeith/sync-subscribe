import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { NoteRecord } from "./types.js";

export function openDb(path = "notes.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      recordId        TEXT PRIMARY KEY,
      userId          TEXT NOT NULL,
      createdAt       INTEGER NOT NULL,
      updatedAt       INTEGER NOT NULL,
      serverUpdatedAt INTEGER,
      revisionCount   INTEGER NOT NULL DEFAULT 1,
      color           TEXT,
      category        TEXT,
      isDeleted       INTEGER NOT NULL DEFAULT 0,
      fontFamily      TEXT,
      title           TEXT NOT NULL DEFAULT '',
      contents        TEXT NOT NULL DEFAULT ''
    );
  `);

  // Migration: add serverUpdatedAt to existing databases that predate this column.
  const columns = (db.pragma("table_info(notes)") as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes("serverUpdatedAt")) {
    db.exec(`ALTER TABLE notes ADD COLUMN serverUpdatedAt INTEGER;`);
  }

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

  const colors = ["blue", "green", "yellow", "red", "purple", "pink", "orange", null];
  const categories = ["work", "personal", "ideas", "reading", "finance", "health", "travel", "misc"];
  const fontFamilies = ["sans-serif", "serif", "monospace", null];
  const users = ["user-123", "user-123", "user-123", "user-123", "user-456"]; // ~80% user-123

  const titleWords = [
    "Meeting notes", "Ideas", "TODO", "Plan", "Summary", "Review", "Draft",
    "Thoughts on", "Notes:", "Recap:", "Follow-up", "Research", "Project",
    "Weekly", "Daily", "Quick note", "Reminder", "Brainstorm", "Outline",
  ];
  const titleTopics = [
    "Q3 goals", "the budget", "API design", "onboarding", "team sync",
    "the roadmap", "performance", "refactoring", "the launch", "interviews",
    "book club", "side project", "vacation", "fitness", "meal prep",
    "reading list", "investments", "home repairs", "learning Rust", "design system",
  ];

  const sentences = [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
    "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
    "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.",
    "Excepteur sint occaecat cupidatat non proident.",
    "Sunt in culpa qui officia deserunt mollit anim id est laborum.",
    "Curabitur pretium tincidunt lacus. Nulla gravida orci a odio.",
    "Nullam varius, turpis molestie dictum semper, nunc augue iaculis pede.",
    "Proin posuere lobortis ligula. Donec vel ante sit amet nisl faucibus.",
    "Vestibulum ante ipsum primis in faucibus orci luctus et ultrices.",
    "Phasellus fermentum enim ac libero molestie, at mollis lacus ultricies.",
    "Etiam sit amet orci eget eros faucibus tincidunt.",
    "Duis leo. Sed fringilla mauris sit amet nibh.",
    "Donec sodales sagittis magna. Sed consequat, leo eget bibendum sodales.",
    "Augue velit cursus nunc, quis gravida magna mi a libero.",
    "Fusce fermentum. Nullam varius nulla a massa fringilla.",
    "Pellentesque habitant morbi tristique senectus et netus et malesuada fames.",
    "Integer vulputate sem a nibh rutrum consequat.",
    "Nam congue tortor eget pulvinar lobortis. Quisque bibendum diam.",
    "Morbi leo risus, porta ac consectetur ac, vestibulum at eros.",
  ];

  function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)] as T;
  }

  function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function makeContents(): string {
    const count = randInt(1, 5);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push(pick(sentences));
    return parts.join(" ");
  }

  function makeTitle(): string {
    return Math.random() < 0.5
      ? pick(titleWords)
      : `${pick(titleWords)} ${pick(titleTopics)}`;
  }

  const stmt = db.prepare(`
    INSERT INTO notes (recordId, userId, createdAt, updatedAt, serverUpdatedAt, revisionCount,
      color, category, isDeleted, fontFamily, title, contents)
    VALUES (@recordId, @userId, @createdAt, @updatedAt, @serverUpdatedAt, @revisionCount,
      @color, @category, @isDeleted, @fontFamily, @title, @contents)
  `);

  const insertMany = db.transaction((notes: NoteRecord[]) => {
    for (const note of notes) {
      stmt.run({ ...note, isDeleted: note.isDeleted ? 1 : 0 });
    }
  });

  const notes: NoteRecord[] = [];
  for (let i = 0; i < 5000; i++) {
    const createdAt = now - randInt(0, 90) * day - randInt(0, day);
    const updatedAt = createdAt + randInt(0, Math.min(7 * day, now - createdAt));
    notes.push({
      recordId: randomUUID(),
      userId: pick(users),
      createdAt,
      updatedAt,
      serverUpdatedAt: updatedAt,
      revisionCount: randInt(1, 10),
      color: pick(colors),
      category: pick(categories),
      isDeleted: Math.random() < 0.05, // ~5% deleted
      fontFamily: pick(fontFamilies),
      title: makeTitle(),
      contents: makeContents(),
    });
  }

  insertMany(notes);
}
