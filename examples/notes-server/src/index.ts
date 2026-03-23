import express from "express";
import cors from "cors";
import { openDb } from "./db.js";
import { NotesStore } from "./notesStore.js";
import { SqliteSubscriptionStore } from "./subscriptionStore.js";
import { SubscriptionManager } from "@sync-subscribe/server";
import type { NoteRecord } from "./types.js";
import { createRouter } from "./routes.js";

const PORT = 3001;

const db = openDb();
const store = new NotesStore(db);

// Subscriptions are loaded on demand (lazy) — no bulk pre-load needed.
const subscriptions = new SubscriptionManager<NoteRecord>(
  new SqliteSubscriptionStore(db),
);

const app = express();

app.use(cors());
app.use(express.json());
app.use("/api", createRouter(store, subscriptions));

app.listen(PORT, () => {
  console.log(`Notes server running at http://localhost:${PORT}`);
});
