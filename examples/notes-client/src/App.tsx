import { useEffect, useMemo, useState } from "react";
import { useRecords, useMutate, useSyncClient, useQuery } from "@sync-subscribe/client-react";
import type { NoteRecord } from "./types.js";
import NotesList from "./components/NotesList.js";
import CreateNoteForm from "./components/CreateNoteForm.js";

type Tab = "all" | "recent" | "blue";
type RecentRange = "1d" | "2d" | "1w" | "1m" | "2m" | "all";

const DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * DAY;

const RANGE_MS: Record<RecentRange, number | null> = {
  "1d": 1 * DAY,
  "2d": 2 * DAY,
  "1w": 7 * DAY,
  "1m": 30 * DAY,
  "2m": 60 * DAY,
  all: null,
};

const RANGE_LABELS: Record<RecentRange, string> = {
  "1d": "Last day",
  "2d": "Last 2 days",
  "1w": "Last week",
  "1m": "Last month",
  "2m": "Last 2 months",
  all: "All time",
};

const tabLabel: Record<Tab, string> = {
  all: "All Local Notes",
  recent: "Recent",
  blue: "Blue Notes",
};

export default function App() {
  const [tab, setTab] = useState<Tab>("recent");
  const [recentRange, setRecentRange] = useState<RecentRange>("1m");
  const [showCreate, setShowCreate] = useState(false);
  const client = useSyncClient<NoteRecord>();
  const mutate = useMutate<NoteRecord>();

  // Sync-only: keep the last 7 days in the local store without loading into memory.
  // liveQuery / query below handle the reactive display based on the selected range.
  useEffect(() => {
    const filter = { createdAt: { $gte: Date.now() - SEVEN_DAYS } };
    let cancelled = false;
    let subId: string | undefined;
    client.subscribe({ filter, name: "recent-7d-sync" }).then((sub) => {
      if (cancelled) {
        void client.unsubscribe(sub.subscriptionId);
      } else {
        subId = sub.subscriptionId;
      }
    });
    return () => {
      cancelled = true;
      if (subId !== undefined) void client.unsubscribe(subId);
    };
  }, [client]);

  // Recompute cutoff only when range changes, not on every render.
  const cutoff = useMemo(() => {
    const ms = RANGE_MS[recentRange];
    return ms !== null ? Date.now() - ms : null;
  }, [recentRange]);

  const recentFilter = useMemo(
    () => (cutoff !== null ? { createdAt: { $gte: cutoff } } : {}),
    [cutoff],
  );

  // Within 7 days: the sync-only subscription keeps this data fresh, so a plain
  // query (local store only) is enough — no new sync subscription needed.
  // Beyond 7 days: liveQuery registers its own sync subscription to pull older data on demand.
  const withinSyncWindow = RANGE_MS[recentRange] !== null && RANGE_MS[recentRange]! <= SEVEN_DAYS;
  const recentFilterKey = JSON.stringify(recentFilter);

  const recentQuery = useMemo(
    () =>
      withinSyncWindow
        ? client.query({ filter: recentFilter })
        : client.liveQuery({ filter: recentFilter }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, recentFilterKey, withinSyncWindow],
  );

  const { data: recentNotes, loading: recentLoading } = useQuery<NoteRecord>(recentQuery);

  const { data: blueNotes, loading: blueLoading } = useRecords<NoteRecord>({
    filter: { color: "blue" },
    name: "blue-notes",
  });

  const loading = recentLoading || blueLoading;

  const allNotes = useMemo(() => {
    const map = new Map<string, NoteRecord>();
    for (const n of [...recentNotes, ...blueNotes]) {
      if (!n.isDeleted) map.set(n.recordId, n);
    }
    return [...map.values()];
  }, [recentNotes, blueNotes]);

  const visibleNotes = useMemo(() => {
    if (tab === "recent") return recentNotes.filter((n) => !n.isDeleted);
    if (tab === "blue") return blueNotes.filter((n) => !n.isDeleted);
    return allNotes;
  }, [tab, allNotes, recentNotes, blueNotes]);

  async function handleCreate(
    data: Omit<NoteRecord, "recordId" | "createdAt" | "updatedAt" | "revisionCount" | "userId">,
  ) {
    await mutate({
      recordId: crypto.randomUUID(),
      userId: "user-123",
      createdAt: Date.now(),
      ...data,
    } as NoteRecord);
    setShowCreate(false);
  }

  async function handleDelete(note: NoteRecord) {
    await mutate({ ...note, isDeleted: true });
  }

  const countFor = (t: Tab) => {
    if (t === "recent") return recentNotes.filter((n) => !n.isDeleted).length;
    if (t === "blue") return blueNotes.filter((n) => !n.isDeleted).length;
    return allNotes.length;
  };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 24,
        }}
      >
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
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: tab === "recent" ? 12 : 20,
        }}
      >
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

      {/* Recent range selector — only visible on the recent tab */}
      {tab === "recent" && (
        <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
          {(Object.keys(RANGE_LABELS) as RecentRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRecentRange(r)}
              style={{
                padding: "5px 12px",
                border: `1.5px solid ${recentRange === r ? "#3b82f6" : "#e2e8f0"}`,
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: recentRange === r ? 600 : 400,
                background: recentRange === r ? "#eff6ff" : "#fff",
                color: recentRange === r ? "#2563eb" : "#64748b",
                fontSize: 12,
                transition: "all 0.15s",
              }}
            >
              {RANGE_LABELS[r]}
              {(RANGE_MS[r] === null || RANGE_MS[r]! > SEVEN_DAYS) && (
                <span
                  style={{
                    marginLeft: 5,
                    fontSize: 10,
                    opacity: 0.6,
                    fontWeight: 400,
                  }}
                >
                  live
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Notes grid */}
      {loading ? (
        <p style={{ color: "#94a3b8", fontSize: 14 }}>Loading…</p>
      ) : (
        <NotesList notes={visibleNotes} onDelete={handleDelete} />
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateNoteForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
