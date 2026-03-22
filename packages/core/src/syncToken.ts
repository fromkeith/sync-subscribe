import type { SyncToken } from "./types.js";

interface TokenPayload {
  updatedAt: number;
  revisionCount: number;
  recordId: string;
}

const toBase64 =
  globalThis.btoa ||
  ((a: string) => globalThis.Buffer.from(a).toString("base64url"));
const fromBase64 =
  globalThis.atob ||
  ((a: string) => globalThis.Buffer.from(a, "base64url").toString("utf8"));

/**
 * Encodes a sync token from its constituent parts.
 * Format: base64(JSON({ updatedAt, revisionCount, recordId }))
 *
 * When reconstructing a token from local data (e.g. to resume a subscription
 * without a server round-trip), pass `serverUpdatedAt` as the `updatedAt`
 * argument — NOT the client's local `updatedAt`. The server clock is
 * authoritative for token comparisons.
 */
export function encodeSyncToken(payload: TokenPayload): SyncToken {
  return toBase64(JSON.stringify(payload)) as SyncToken;
}

/**
 * Decodes a sync token. Returns null if the token is empty or malformed.
 */
export function decodeSyncToken(token: SyncToken): TokenPayload | null {
  if (!token) return null;
  try {
    return JSON.parse(fromBase64(token as string)) as TokenPayload;
  } catch {
    return null;
  }
}
