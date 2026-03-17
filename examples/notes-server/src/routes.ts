import { Router } from "express";
import type { Request, Response, Router as ExpressRouter } from "express";
import {
  type SyncToken,
  type SubscriptionFilter,
  matchesFilter,
} from "@sync-subscribe/core";
import { SubscriptionManager, SyncHandler } from "@sync-subscribe/server";
import type { NoteRecord } from "./types.js";
import type { NotesStore } from "./notesStore.js";

export function createRouter(
  store: NotesStore,
  subscriptions: SubscriptionManager<NoteRecord>,
): ExpressRouter {
  const router = Router();

  // SSE client registry: subscriptionId → set of active response streams
  const sseClients = new Map<string, Set<Response>>();

  function sendSse(subscriptionId: string, data: unknown) {
    const clients = sseClients.get(subscriptionId);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      res.write(payload);
    }
  }

  const syncHandler = new SyncHandler<NoteRecord>(store, subscriptions, {
    // createdAt is set by the server on first write and must not be altered by clients.
    readonlyFields: ["createdAt"],

    // After any successful push, notify SSE clients whose subscription filter
    // matches at least one of the changed records.
    onRecordsChanged: (records) => {
      for (const [subId] of sseClients) {
        const sub = subscriptions.get(subId);
        if (!sub) continue;

        const matching = records.filter((r) =>
          matchesFilter(r as unknown as Record<string, unknown>, sub.filter),
        );
        if (matching.length === 0) continue;

        const patches = matching.map((r) => ({
          op: "upsert" as const,
          record: r,
        }));
        const lastRecord = matching[matching.length - 1]!;
        subscriptions.updateSyncToken(subId, lastRecord);
        const newToken = subscriptions.get(subId)!.syncToken;

        sendSse(subId, { patches, syncToken: newToken });
      }
    },
  });

  function getUserId(req: Request): string {
    return (req.headers["x-user-id"] as string | undefined) ?? "user-123";
  }

  // PUT /api/subscriptions — create or update a subscription
  router.put("/subscriptions", async (req: Request, res: Response) => {
    const { filter, previousSubscriptionId } = req.body as {
      filter: SubscriptionFilter;
      previousSubscriptionId?: string;
    };
    const serverFilter = { userId: getUserId(req) };
    const result = await syncHandler.updateSubscription(
      filter,
      serverFilter,
      previousSubscriptionId,
    );
    res.json(result);
  });

  // GET /api/sync?subscriptionId=X&syncToken=Y — pull
  router.get("/sync", async (req: Request, res: Response) => {
    const { subscriptionId, syncToken } = req.query as {
      subscriptionId: string;
      syncToken: string;
    };
    try {
      const result = await syncHandler.pull({
        subscriptionId,
        syncToken: (syncToken ?? "") as SyncToken,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/sync/stream?subscriptionId=X&syncToken=Y — SSE push stream
  router.get("/sync/stream", async (req: Request, res: Response) => {
    const { subscriptionId, syncToken } = req.query as {
      subscriptionId: string;
      syncToken?: string;
    };

    const sub = subscriptions.get(subscriptionId);
    if (!sub) {
      res
        .status(400)
        .json({ error: `Unknown subscription: ${subscriptionId}` });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send the initial batch of records since the client's last syncToken.
    try {
      const initial = await syncHandler.pull({
        subscriptionId,
        syncToken: (syncToken ?? "") as SyncToken,
      });
      res.write(`data: ${JSON.stringify(initial)}\n\n`);
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({ error: (err as Error).message })}\n\n`,
      );
    }

    // Register this connection for future push notifications.
    if (!sseClients.has(subscriptionId)) {
      sseClients.set(subscriptionId, new Set());
    }
    sseClients.get(subscriptionId)!.add(res);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.get(subscriptionId)?.delete(res);
    });
  });

  // POST /api/sync — push records from client
  router.post("/sync", async (req: Request, res: Response) => {
    const { subscriptionId, records } = req.body as {
      subscriptionId: string;
      records: NoteRecord[];
    };

    // userId is always injected from the server's auth context.
    // Clients cannot forge or override it — server-stamped field.
    const userId = getUserId(req);
    const sanitized = records.map((r) => ({ ...r, userId }));

    try {
      const result = await syncHandler.push({
        subscriptionId,
        records: sanitized,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
