import { createFetchTransport } from "@sync-subscribe/client";

// In a real app the userId/token comes from your auth layer.
// The server injects it as a server-side filter on every subscription,
// so the client can never see or override it.
export const transport = createFetchTransport({
  baseUrl: "/api",
  headers: () => ({ "X-User-Id": "user-123" }),
});
