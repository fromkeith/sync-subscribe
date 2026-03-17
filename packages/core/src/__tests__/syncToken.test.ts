import { describe, expect, it } from "vitest";
import { decodeSyncToken, encodeSyncToken } from "../syncToken.js";
import { EMPTY_SYNC_TOKEN } from "../types.js";

describe("syncToken", () => {
  it("round-trips a token", () => {
    const payload = { updatedAt: 12345, revisionCount: 7, recordId: "abc" };
    const token = encodeSyncToken(payload);
    expect(decodeSyncToken(token)).toEqual(payload);
  });

  it("returns null for empty token", () => {
    expect(decodeSyncToken(EMPTY_SYNC_TOKEN)).toBeNull();
  });

  it("returns null for malformed token", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(decodeSyncToken("not-valid-base64!!!" as any)).toBeNull();
  });
});
