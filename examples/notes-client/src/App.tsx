import { useMemo, useState } from "react";
import { useRecords, useMutate } from "@sync-subscribe/client-react";
import type { NoteRecord } from "./types.js";
import NotesList from "./components/NotesList.js";
import CreateNoteForm from "./components/CreateNoteForm.js";

type Tab = "all" | "recent" | "blue";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const tabLabel: Record<Tab, string> = {
  all: "All Notes",
  recent: "Recent (30 days)",
  blue: "Blue Notes",
};

export default function App() {
  const [tab, setTab] = useState<Tab>("all");
  const [showCreate, setShowCreate] = useState(false);
  const mutate = useMutate<NoteRecord>();

  // Stable cutoff so the filter doesn't change identity on every render.
  const thirtyDaysAgo = useMemo(() => Date.now() - THIRTY_DAYS, []);

  // Two server-side subscriptions, mirroring the original design.
  // Both share the same LocalStore so overlapping records are stored once.
  const recentNotes = useRecords<NoteRecord>({
    filter: { createdAt: { $gte: thirtyDaysAgo } },
  });
  const blueNotes = useRecords<NoteRecord>({
    filter: { color: "blue" },
  });

  // Merge both views into one deduped list (by recordId), excluding deleted.
  const allNotes = useMemo(() => {
    const map = new Map<string, NoteRecord>();
    for (const n of [...recentNotes, ...blueNotes]) {
      if (!n.isDeleted) map.set(n.recordId, n);
    }
    return [...map.values()];
  }, [recentNotes, blueNotes]);

  const visibleNotes = useMemo(() => {
    if (tab === "recent") return allNotes.filter((n) => n.createdAt >= thirtyDaysAgo);
    if (tab === "blue") return allNotes.filter((n) => n.color === "blue");
    return allNotes;
  }, [tab, allNotes, thirtyDaysAgo]);

  async function handleCreate(
    data: Omit<NoteRecord, "recordId" | "createdAt" | "updatedAt" | "revisionCount" | "userId">
  ) {
    await mutate({
      recordId: crypto.randomUUID(),
      userId: "user-123",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revisionCount: 1,
      ...data,
    });
    setShowCreate(false);
  }

  async function handleDelete(note: NoteRecord) {
    await mutate({
      ...note,
      isDeleted: true,
      updatedAt: Date.now(),
      revisionCount: note.revisionCount + 1,
    });
  }

  const countFor = (t: Tab) => {
    if (t === "recent") return allNotes.filter((n) => n.createdAt >= thirtyDaysAgo).length;
    if (t === "blue") return allNotes.filter((n) => n.color === "blue").length;
    return allNotes.length;
  };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, flex: 1 }}>Notes</h1>
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
              {countFor(t)}
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
