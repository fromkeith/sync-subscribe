import type { SyncTransport } from "@sync-subscribe/client";
import type { SubscriptionFilter, SyncToken } from "@sync-subscribe/core";

const BASE = "/api";
// In a real app this comes from auth. Here it's a hardcoded demo value.
// The server uses this to partition data — the client can't see or override
// the server-side userId filter injected into every subscription.
const USER_ID = "user-123";

function headers(extra?: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", "X-User-Id": USER_ID, ...extra };
}

export function createTransport(): SyncTransport {
  return {
    async createSubscription(
      filter: SubscriptionFilter,
      previousSubscriptionId?: string
    ) {
      const res = await fetch(`${BASE}/subscriptions`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ filter, previousSubscriptionId }),
      });
      if (!res.ok) throw new Error(`Subscription failed: ${res.status}`);
      return res.json();
    },

    async pull(subscriptionId: string, syncToken: SyncToken) {
      const qs = new URLSearchParams({ subscriptionId, syncToken });
      const res = await fetch(`${BASE}/sync?${qs}`, {
        headers: { "X-User-Id": USER_ID },
      });
      if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
      return res.json();
    },

    async push(subscriptionId: string, records: unknown[]) {
      const res = await fetch(`${BASE}/sync`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ subscriptionId, records }),
      });
      if (!res.ok) throw new Error(`Push failed: ${res.status}`);
      return res.json();
    },
  };
}
