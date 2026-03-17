import { useState } from "react";
import type { NoteRecord } from "../types.js";
import { COLORS, COLOR_HEX, FONT_FAMILIES } from "../types.js";

type CreateData = Omit<NoteRecord, "recordId" | "createdAt" | "updatedAt" | "revisionCount" | "userId">;

interface Props {
  onSubmit: (data: CreateData) => void;
  onCancel: () => void;
}

export default function CreateNoteForm({ onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState("");
  const [contents, setContents] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [fontFamily, setFontFamily] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({ title, contents, color, category: category || null, fontFamily, isDeleted: false });
  }

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(15,23,42,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
    padding: 16,
  };

  const modal: React.CSSProperties = {
    background: "#fff",
    borderRadius: 16,
    padding: 24,
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  };

  const label: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#475569" };

  const input: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontSize: 14,
    outline: "none",
    fontFamily: "inherit",
  };

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <form style={modal} onSubmit={handleSubmit}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "#1e293b" }}>New note</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={label}>Title</label>
          <input
            style={input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Note title"
            required
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={label}>Contents</label>
          <textarea
            style={{ ...input, minHeight: 100, resize: "vertical" }}
            value={contents}
            onChange={(e) => setContents(e.target.value)}
            placeholder="Write something…"
          />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          {/* Color */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={label}>Color</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[null, ...COLORS].map((c) => (
                <button
                  key={c ?? "none"}
                  type="button"
                  onClick={() => setColor(c)}
                  title={c ?? "none"}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    border: color === c ? "3px solid #1e293b" : "2px solid #e2e8f0",
                    background: c ? COLOR_HEX[c] : "#e2e8f0",
                    cursor: "pointer",
                  }}
                />
              ))}
            </div>
          </div>

          {/* Category */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={label}>Category</label>
            <input
              style={input}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. work, ideas"
            />
          </div>
        </div>

        {/* Font family */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={label}>Font family</label>
          <select
            style={input}
            value={fontFamily ?? ""}
            onChange={(e) => setFontFamily(e.target.value || null)}
          >
            <option value="">Default</option>
            {FONT_FAMILIES.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 20px",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              background: "#fff",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            style={{
              padding: "8px 20px",
              border: "none",
              borderRadius: 8,
              background: "#3b82f6",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
