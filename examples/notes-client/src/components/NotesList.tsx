import { useMemo } from "react";
import type { NoteRecord } from "../types.js";
import NoteCard from "./NoteCard.js";

interface Props {
  notes: NoteRecord[];
  onDelete: (note: NoteRecord) => void;
}

export default function NotesList({ notes, onDelete }: Props) {
  if (notes.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "64px 0",
          color: "#94a3b8",
          fontSize: 15,
        }}
      >
        No notes yet. Create one above.
      </div>
    );
  }
  const notesSorted = useMemo(() => {
    return notes.sort((a, b) => {
      return b.createdAt - a.createdAt;
    });
  }, [notes]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16,
      }}
    >
      {notesSorted.map((note) => (
        <NoteCard key={note.recordId} note={note} onDelete={onDelete} />
      ))}
    </div>
  );
}
