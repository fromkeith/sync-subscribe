import { describe, expect, it } from "vitest";
import { EMPTY_SYNC_TOKEN } from "@sync-subscribe/core";
import type { SyncRecord } from "@sync-subscribe/core";
import { SubscriptionManager } from "../subscriptionManager.js";

interface R extends SyncRecord { name: string }

describe("SubscriptionManager", () => {
  it("create returns a subscription with EMPTY syncToken", async () => {
    const mgr = new SubscriptionManager<R>();
    const sub = await mgr.create({ color: "blue" }, { userId: "u1" });
    expect(sub.syncToken).toBe(EMPTY_SYNC_TOKEN);
    expect(sub.clientFilter).toEqual({ color: "blue" });
    expect(sub.filter).toEqual({ color: "blue" }); // client-visible filter
    expect(sub.serverFilter).toEqual({ color: "blue", userId: "u1" }); // merged (clientFilter ⊆ serverFilter)
  });

  it("update with same filter preserves syncToken (partial sync)", async () => {
    const mgr = new SubscriptionManager<R>();
    const original = await mgr.create({ color: "blue" }, { userId: "u1" });
    // Manually advance the token
    const token = mgr.updateSyncToken(original.subscriptionId, {
      recordId: "r1", updatedAt: 999, revisionCount: 1, createdAt: 0,
    });

    const { subscription, resetRequired } = await mgr.update(
      original.subscriptionId,
      { color: "blue" },
      { userId: "u1" }
    );

    expect(resetRequired).toBe(false);
    expect(subscription.syncToken).toBe(token);
    // update is in-place: same subscriptionId is preserved
    expect(await mgr.get(original.subscriptionId)).toBeDefined();
    expect((await mgr.get(original.subscriptionId))?.subscriptionId).toBe(original.subscriptionId);
  });

  it("update with different filter resets syncToken (full sync)", async () => {
    const mgr = new SubscriptionManager<R>();
    const original = await mgr.create({ color: "blue" }, { userId: "u1" });
    mgr.updateSyncToken(original.subscriptionId, {
      recordId: "r1", updatedAt: 999, revisionCount: 1, createdAt: 0,
    });

    const { subscription, resetRequired } = await mgr.update(
      original.subscriptionId,
      { color: "red" }, // filter changed
      { userId: "u1" }
    );

    expect(resetRequired).toBe(true);
    expect(subscription.syncToken).toBe(EMPTY_SYNC_TOKEN);
  });

  it("update with unknown previousId creates new subscription with full sync", async () => {
    const mgr = new SubscriptionManager<R>();
    const { resetRequired } = await mgr.update("does-not-exist", { color: "blue" });
    expect(resetRequired).toBe(true);
  });
});
