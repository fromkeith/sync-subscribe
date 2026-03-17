import type { NoteRecord } from "../types.js";
import { COLOR_HEX } from "../types.js";

interface Props {
  note: NoteRecord;
  onDelete: (note: NoteRecord) => void;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

export default function NoteCard({ note, onDelete }: Props) {
  const accent = note.color ? (COLOR_HEX[note.color] ?? "#94a3b8") : "#94a3b8";

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        padding: 16,
        border: `2px solid ${accent}22`,
        borderTop: `4px solid ${accent}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        position: "relative",
      }}
    >
      {/* Color + category row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {note.color && (
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: accent,
              flexShrink: 0,
            }}
          />
        )}
        {note.category && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "#94a3b8",
            }}
          >
            {note.category}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#cbd5e1" }}>
          rev {note.revisionCount}
        </span>
      </div>

      {/* Title */}
      <h3
        style={{
          fontSize: 15,
          fontWeight: 600,
          fontFamily: note.fontFamily ?? undefined,
          color: "#1e293b",
        }}
      >
        {note.title || "(untitled)"}
      </h3>

      {/* Contents */}
      {note.contents && (
        <p
          style={{
            fontSize: 13,
            color: "#64748b",
            lineHeight: 1.5,
            fontFamily: note.fontFamily ?? undefined,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          } as React.CSSProperties}
        >
          {note.contents}
        </p>
      )}

      {/* Footer */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "auto",
          paddingTop: 8,
          borderTop: "1px solid #f1f5f9",
        }}
      >
        <span style={{ fontSize: 11, color: "#cbd5e1" }}>{timeAgo(note.createdAt)}</span>
        <button
          onClick={() => onDelete(note)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#cbd5e1",
            fontSize: 13,
            padding: "2px 6px",
            borderRadius: 6,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#ef4444")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#cbd5e1")}
          title="Delete note"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
