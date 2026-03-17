import { useState, useEffect, useCallback, useRef } from "react";
import { SyncClient } from "@sync-subscribe/client";
import { createTransport } from "./transport.js";
import type { NoteRecord } from "./types.js";
import NotesList from "./components/NotesList.js";
import CreateNoteForm from "./components/CreateNoteForm.js";

type Tab = "all" | "recent" | "blue";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

// Module-level client — persists across React re-renders
const client = new SyncClient<NoteRecord>(createTransport());

const tabLabel: Record<Tab, string> = {
  all: "All Notes",
  recent: "Recent (30 days)",
  blue: "Blue Notes",
};

export default function App() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [status, setStatus] = useState<"idle" | "syncing" | "error">("idle");
  const initialized = useRef(false);

  const refreshNotes = useCallback(() => {
    setNotes(client.store.getAll().filter((n) => !n.isDeleted));
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    let cancelled = false;

    async function init() {
      setStatus("syncing");
      try {
        const thirtyDaysAgo = Date.now() - THIRTY_DAYS;
        // Two simultaneous subscriptions — notes in both are stored once locally
        await client.subscribe({ filter: { createdAt: { $gte: thirtyDaysAgo } } });
        await client.subscribe({ filter: { color: "blue" } });
        await client.pull();
        if (!cancelled) refreshNotes();
        setStatus("idle");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    init();

    const unsub = client.onPatches(() => {
      if (!cancelled) refreshNotes();
    });

    // Poll every 5 s so multiple browser tabs stay in sync
    const timer = setInterval(async () => {
      try {
        await client.pull();
      } catch {
        // swallow — will retry next tick
      }
    }, 5000);

    return () => {
      cancelled = true;
      unsub();
      clearInterval(timer);
    };
  }, [refreshNotes]);

  const visibleNotes = notes.filter((n) => {
    if (tab === "recent") return n.createdAt >= Date.now() - THIRTY_DAYS;
    if (tab === "blue") return n.color === "blue";
    return true;
  });

  async function handleCreate(
    data: Omit<NoteRecord, "recordId" | "createdAt" | "updatedAt" | "revisionCount" | "userId">
  ) {
    const note: NoteRecord = {
      recordId: crypto.randomUUID(),
      userId: "user-123",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revisionCount: 1,
      ...data,
    };
    await client.mutate(note);
    refreshNotes();
    setShowCreate(false);
  }

  async function handleDelete(note: NoteRecord) {
    await client.mutate({
      ...note,
      isDeleted: true,
      updatedAt: Date.now(),
      revisionCount: note.revisionCount + 1,
    });
    refreshNotes();
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, flex: 1 }}>Notes</h1>
        <span
          style={{
            fontSize: 12,
            color: status === "error" ? "#ef4444" : "#64748b",
            background: "#f1f5f9",
            padding: "4px 10px",
            borderRadius: 9999,
          }}
        >
          {status === "syncing" ? "Syncing…" : status === "error" ? "Sync error" : "Live"}
        </span>
        <button
          onClick={() => setShowCreate(true)}
          style={{
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "8px 16px",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          + New note
        </button>
      </div>

      {/* Subscription tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
        {(["all", "recent", "blue"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              fontWeight: tab === t ? 600 : 400,
              background: tab === t ? "#1e293b" : "#e2e8f0",
              color: tab === t ? "#fff" : "#475569",
              fontSize: 14,
              transition: "all 0.15s",
            }}
          >
            {tabLabel[t]}
            <span
              style={{
                marginLeft: 8,
                background: tab === t ? "rgba(255,255,255,0.2)" : "#cbd5e1",
                color: tab === t ? "#fff" : "#475569",
                borderRadius: 9999,
                padding: "1px 7px",
                fontSize: 11,
              }}
            >
              {tab === t ? visibleNotes.length : notes.filter((n) => {
                if (t === "recent") return n.createdAt >= Date.now() - THIRTY_DAYS;
                if (t === "blue") return n.color === "blue";
                return true;
              }).length}
            </span>
          </button>
        ))}
      </div>

      {/* Notes grid */}
      <NotesList notes={visibleNotes} onDelete={handleDelete} />

      {/* Create modal */}
      {showCreate && (
        <CreateNoteForm onSubmit={handleCreate} onCancel={() => setShowCreate(false)} />
      )}
    </div>
  );
}
