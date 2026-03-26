import express from "express";
import cors from "cors";
import { openDb } from "./db.js";
import { NotesStore } from "./notesStore.js";
import { createRouter } from "./routes.js";

const PORT = 3001;

const db = openDb();
const store = new NotesStore(db);

const app = express();

app.use(cors());
app.use(express.json());
app.use("/api", createRouter(store));

app.listen(PORT, () => {
  console.log(`Notes server running at http://localhost:${PORT}`);
});
