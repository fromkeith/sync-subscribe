import { z } from "zod";
import type { SyncRecord } from "@sync-subscribe/core";
import type { TableSchema } from "@sync-subscribe/core";

export interface NoteRecord extends SyncRecord {
  userId: string;
  color: string | null;
  category: string | null;
  isDeleted: boolean;
  fontFamily: string | null;
  title: string;
  contents: string;
}

export const noteSchema: TableSchema<NoteRecord> = {
  schema: z.object({
    recordId: z.string(),
    userId: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    revisionCount: z.number(),
    color: z.string().nullable(),
    category: z.string().nullable(),
    isDeleted: z.boolean(),
    fontFamily: z.string().nullable(),
    title: z.string(),
    contents: z.string(),
  }),
  tableName: "notes",
  recordId: "recordId",
  indexes: [["userId"], ["isDeleted"], ["updatedAt"]],
};

export const COLORS = ["blue", "green", "red", "yellow", "purple"] as const;
export type NoteColor = (typeof COLORS)[number];

export const COLOR_HEX: Record<string, string> = {
  blue: "#3b82f6",
  green: "#22c55e",
  red: "#ef4444",
  yellow: "#eab308",
  purple: "#a855f7",
};

export const FONT_FAMILIES = [
  "system-ui",
  "serif",
  "monospace",
  "Georgia, serif",
  "Courier New, monospace",
] as const;
