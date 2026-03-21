import type { SyncRecord, SyncPatch, SyncToken, SubscriptionFilter } from "@sync-subscribe/core";
import type { SyncTransport, ClientSubscription } from "./types.js";

export interface FetchTransportOptions {
  /** Base URL of the sync server, e.g. "/api" or "https://api.example.com". */
  baseUrl: string;
  /**
   * Called before every request to supply additional headers (e.g. Authorization).
   * Return an empty object if no extra headers are needed.
   */
  headers?: () => Record<string, string>;
}

/**
 * A fetch + EventSource-based SyncTransport that works in any modern browser.
 *
 * Covers all four transport methods:
 *   - createSubscription  →  PUT  {baseUrl}/subscriptions
 *   - pull               →  GET  {baseUrl}/sync?subscriptionId=&syncToken=
 *   - push               →  POST {baseUrl}/sync
 *   - stream             →  GET  {baseUrl}/sync/stream?subscriptionId=&syncToken=  (SSE)
 *
 * @example
 * const transport = createFetchTransport({
 *   baseUrl: "/api",
 *   headers: () => ({ Authorization: `Bearer ${getToken()}` }),
 * });
 * const client = new SyncClient(transport);
 */
export function createFetchTransport(options: FetchTransportOptions): SyncTransport {
  const { baseUrl, headers = () => ({}) } = options;

  function jsonHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", ...headers() };
  }

  return {
    async createSubscription(filter: SubscriptionFilter, previousSubscriptionId?: string): Promise<ClientSubscription> {
      const body: Record<string, unknown> = { filter };
      if (previousSubscriptionId !== undefined) {
        body["previousSubscriptionId"] = previousSubscriptionId;
      }
      const res = await fetch(`${baseUrl}/subscriptions`, {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Subscription failed: ${res.status}`);
      return res.json();
    },

    async pull(subscriptionId: string, syncToken: SyncToken): Promise<{ patches: SyncPatch<SyncRecord>[]; syncToken: SyncToken }> {
      const qs = new URLSearchParams({ subscriptionId, syncToken });
      const res = await fetch(`${baseUrl}/sync?${qs}`, { headers: headers() });
      if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
      return res.json();
    },

    async push(subscriptionId: string, records: SyncRecord[]): Promise<{ ok: true } | { conflict: true; serverRecord: SyncRecord }> {
      const res = await fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ subscriptionId, records }),
      });
      if (!res.ok) throw new Error(`Push failed: ${res.status}`);
      return res.json();
    },

    stream(
      subscriptionId: string,
      syncToken: SyncToken,
      onMessage: (payload: { patches: SyncPatch<SyncRecord>[]; syncToken: SyncToken }) => void,
      onError?: (err: Error) => void,
    ): () => void {
      const qs = new URLSearchParams({ subscriptionId, syncToken });
      const es = new EventSource(`${baseUrl}/sync/stream?${qs}`);

      es.onmessage = (e: MessageEvent) => {
        try {
          onMessage(JSON.parse(e.data as string));
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      };

      es.onerror = () => {
        onError?.(new Error("SSE connection error"));
      };

      return () => es.close();
    },
  };
}
