import { Router } from "express";
import type { Request, Response, Router as ExpressRouter } from "express";
import {
  type SyncToken,
  type SubscriptionFilter,
  type StreamEvent,
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

  // SSE client registry: one entry per open connection (multiple subscriptions per connection)
  interface SseConnection {
    subscriptionIds: string[];
    res: Response;
  }
  const sseConnections = new Set<SseConnection>();

  function sendSseToConnection(conn: SseConnection, data: unknown) {
    conn.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  const syncHandler = new SyncHandler<NoteRecord>(store, subscriptions, {
    // createdAt is set by the server on first write and must not be altered by clients.
    readonlyFields: ["createdAt"],

    // After any successful push, notify SSE clients whose subscription filter
    // matches at least one of the changed records.
    onRecordsChanged: (records) => {
      for (const conn of sseConnections) {
        const matchingPatches: StreamEvent<NoteRecord>["patches"] = [];
        const syncTokensMap: Record<string, SyncToken> = {};

        for (const subId of conn.subscriptionIds) {
          const sub = subscriptions.get(subId);
          if (!sub) continue;

          const matching = records.filter((r) =>
            matchesFilter(r as unknown as Record<string, unknown>, sub.filter),
          );
          if (matching.length === 0) continue;

          const lastRecord = matching[matching.length - 1]!;
          subscriptions.updateSyncToken(subId, lastRecord);
          syncTokensMap[subId] = subscriptions.get(subId)!.syncToken;

          for (const r of matching) {
            matchingPatches.push({ op: "upsert", record: r });
          }
        }

        if (matchingPatches.length > 0) {
          sendSseToConnection(conn, {
            patches: matchingPatches,
            syncTokens: syncTokensMap,
          } satisfies StreamEvent<NoteRecord>);
        }
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

  // DELETE /api/subscriptions/:id — remove a subscription (used to clean up gap subs)
  router.delete("/subscriptions/:id", async (req: Request, res: Response) => {
    await subscriptions.delete(req.params["id"] as string);
    res.status(204).end();
  });

  // POST /api/sync/pull — pull patches for all requested subscriptions
  router.post("/sync/pull", async (req: Request, res: Response) => {
    const { subscriptions: subs } = req.body as {
      subscriptions: { id: string; syncToken: string }[];
    };
    try {
      const allPatches: import("@sync-subscribe/core").SyncPatch<NoteRecord>[] = [];
      const syncTokens: Record<string, SyncToken> = {};
      for (const sub of subs) {
        const result = await syncHandler.pull({
          subscriptionId: sub.id,
          syncToken: (sub.syncToken ?? "") as SyncToken,
        });
        allPatches.push(...result.patches);
        syncTokens[sub.id] = result.syncToken;
      }
      // Deduplicate patches — last write per recordId wins
      const patchMap = new Map<string, import("@sync-subscribe/core").SyncPatch<NoteRecord>>();
      for (const p of allPatches) {
        const key = p.op === "upsert" ? p.record.recordId : p.recordId;
        patchMap.set(key, p);
      }
      res.json({ patches: [...patchMap.values()], syncTokens });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/sync/stream — POST-based SSE stream for multiple subscriptions
  router.post("/sync/stream", async (req: Request, res: Response) => {
    const { subscriptions: subs } = req.body as {
      subscriptions: { id: string; syncToken?: string }[];
    };

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send the initial batch of records since each subscription's last syncToken.
    try {
      const allPatches: import("@sync-subscribe/core").SyncPatch<NoteRecord>[] = [];
      const syncTokens: Record<string, SyncToken> = {};
      for (const sub of subs) {
        const result = await syncHandler.pull({
          subscriptionId: sub.id,
          syncToken: (sub.syncToken ?? "") as SyncToken,
        });
        allPatches.push(...result.patches);
        syncTokens[sub.id] = result.syncToken;
      }
      const patchMap = new Map<string, import("@sync-subscribe/core").SyncPatch<NoteRecord>>();
      for (const p of allPatches) {
        const key = p.op === "upsert" ? p.record.recordId : p.recordId;
        patchMap.set(key, p);
      }
      res.write(`data: ${JSON.stringify({ patches: [...patchMap.values()], syncTokens })}\n\n`);
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({ error: (err as Error).message })}\n\n`,
      );
    }

    // Register this connection for future push notifications.
    const conn: SseConnection = {
      subscriptionIds: subs.map((s) => s.id),
      res,
    };
    sseConnections.add(conn);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseConnections.delete(conn);
    });
  });

  // POST /api/sync/push — push records from client
  router.post("/sync/push", async (req: Request, res: Response) => {
    const { records } = req.body as {
      records: NoteRecord[];
    };

    // userId is always injected from the server's auth context.
    const userId = getUserId(req);
    const sanitized = records.map((r) => ({ ...r, userId }));

    try {
      const result = await syncHandler.push({ records: sanitized });
      if ("ok" in result) {
        res.json({ ok: true, serverUpdatedAt: Date.now() });
      } else {
        res.json(result);
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
