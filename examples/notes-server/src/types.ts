import type { SyncRecord } from "@sync-subscribe/core";

export interface NoteRecord extends SyncRecord {
  // recordId (from SyncRecord) is the note's unique id
  userId: string;
  color: string | null;
  category: string | null;
  isDeleted: boolean;
  fontFamily: string | null;
  title: string;
  contents: string;
}
