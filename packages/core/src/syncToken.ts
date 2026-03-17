import type { SyncToken } from "./types.js";

interface TokenPayload {
  updatedAt: number;
  revisionCount: number;
  recordId: string;
}

/**
 * Encodes a sync token from its constituent parts.
 * Format: base64(JSON({ updatedAt, revisionCount, recordId }))
 */
export function encodeSyncToken(payload: TokenPayload): SyncToken {
  return Buffer.from(JSON.stringify(payload)).toString("base64url") as SyncToken;
}

/**
 * Decodes a sync token. Returns null if the token is empty or malformed.
 */
export function decodeSyncToken(token: SyncToken): TokenPayload | null {
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
}
