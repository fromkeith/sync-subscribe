import type { SyncRecord, SyncPatch, SyncToken, SubscriptionFilter, StreamEvent } from "@sync-subscribe/core";
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
 * A fetch-based SyncTransport that works in any modern browser.
 *
 * Endpoints:
 *   - createSubscription  →  PUT  {baseUrl}/subscriptions
 *   - pull               →  POST {baseUrl}/sync/pull
 *   - push               →  POST {baseUrl}/sync/push
 *   - stream             →  POST {baseUrl}/sync/stream  (fetch-based SSE)
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

    async deleteSubscription(subscriptionId: string): Promise<void> {
      const res = await fetch(`${baseUrl}/subscriptions/${subscriptionId}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!res.ok) throw new Error(`Delete subscription failed: ${res.status}`);
    },

    async pull(subscriptions: { id: string; syncToken: SyncToken }[]): Promise<{ patches: SyncPatch<SyncRecord>[]; syncTokens: Record<string, SyncToken> }> {
      const res = await fetch(`${baseUrl}/sync/pull`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ subscriptions }),
      });
      if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
      return res.json();
    },

    async push(records: SyncRecord[]): Promise<{ ok: true; serverUpdatedAt: number } | { conflict: true; serverRecord: SyncRecord }> {
      const res = await fetch(`${baseUrl}/sync/push`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ records }),
      });
      if (!res.ok) throw new Error(`Push failed: ${res.status}`);
      return res.json();
    },

    stream(
      subscriptions: { id: string; syncToken: SyncToken }[],
      onMessage: (event: StreamEvent) => void,
      onError?: (err: Error) => void,
    ): () => void {
      const controller = new AbortController();

      fetch(`${baseUrl}/sync/stream`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ subscriptions }),
        signal: controller.signal,
      }).then(async (res) => {
        if (!res.ok) {
          onError?.(new Error(`Stream failed: ${res.status}`));
          return;
        }
        if (!res.body) {
          onError?.(new Error("No response body"));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                onMessage(JSON.parse(line.slice(6)) as StreamEvent);
              } catch (err) {
                onError?.(err instanceof Error ? err : new Error(String(err)));
              }
            }
          }
        }
      }).catch((err: unknown) => {
        if ((err as Error)?.name !== "AbortError") {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      });

      return () => controller.abort();
    },
  };
}
