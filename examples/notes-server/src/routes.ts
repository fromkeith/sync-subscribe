import { Router } from "express";
import type { Request, Response, Router as ExpressRouter } from "express";
import {
  type SyncToken,
  type SubscriptionFilter,
  type StreamEvent,
  type SyncPatch,
  matchesFilter,
  encodeSyncToken,
} from "@sync-subscribe/core";
import { SyncHandler } from "@sync-subscribe/server";
import type { SyncSubscriptionRequest } from "@sync-subscribe/server";
import type { NoteRecord } from "./types.js";
import type { NotesStore } from "./notesStore.js";

export function createRouter(store: NotesStore): ExpressRouter {
  const router = Router();

  // SSE client registry: one entry per open connection.
  // Holds the server-merged subscription list so fan-out never touches the DB.
  interface SseConnection {
    subscriptions: { key: string; filter: SubscriptionFilter }[];
    res: Response;
  }
  const sseConnections = new Set<SseConnection>();

  const syncHandler = new SyncHandler<NoteRecord>(store, {
    // createdAt is set by the server on first write and must not be altered by clients.
    readonlyFields: ["createdAt"],

    // After any successful push, notify SSE clients whose subscription filter
    // matches at least one of the changed records.
    onRecordsChanged: (records) => {
      for (const conn of sseConnections) {
        const patches: SyncPatch<NoteRecord>[] = [];
        const syncTokens: Record<string, SyncToken> = {};

        for (const sub of conn.subscriptions) {
          const matching = records.filter((r) =>
            matchesFilter(r as unknown as Record<string, unknown>, sub.filter),
          );
          if (matching.length === 0) continue;

          const lastRecord = matching[matching.length - 1]!;
          syncTokens[sub.key] = encodeSyncToken({
            updatedAt: lastRecord.updatedAt,
            revisionCount: lastRecord.revisionCount,
            recordId: lastRecord.recordId,
          });

          for (const r of matching) {
            patches.push({ op: "upsert", record: r });
          }
        }

        if (patches.length === 0) continue;

        // Deduplicate patches — last write per recordId wins
        const patchMap = new Map<string, SyncPatch<NoteRecord>>();
        for (const p of patches) {
          const k = p.op === "upsert" ? p.record.recordId : p.recordId;
          patchMap.set(k, p);
        }

        conn.res.write(
          `data: ${JSON.stringify({ patches: [...patchMap.values()], syncTokens } satisfies StreamEvent<NoteRecord>)}\n\n`,
        );
      }
    },
  });

  function getUserId(req: Request): string {
    return (req.headers["x-user-id"] as string | undefined) ?? "user-123";
  }

  /**
   * Merge the server-side userId filter into each client subscription.
   * The client is unaware of this addition — it only sees its own filter.
   */
  function mergeServerFilter(
    subs: SyncSubscriptionRequest[],
    userId: string,
  ): SyncSubscriptionRequest[] {
    return subs.map((s) => ({
      ...s,
      filter: { ...s.filter, userId } as SubscriptionFilter,
    }));
  }

  // POST /api/sync/pull — pull patches for all requested subscriptions
  router.post("/sync/pull", async (req: Request, res: Response) => {
    const { subscriptions } = req.body as { subscriptions: SyncSubscriptionRequest[] };
    const userId = getUserId(req);
    const merged = mergeServerFilter(subscriptions, userId);

    try {
      const result = await syncHandler.pull(merged);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/sync/stream — POST-based SSE stream for multiple subscriptions
  router.post("/sync/stream", async (req: Request, res: Response) => {
    const { subscriptions } = req.body as { subscriptions: SyncSubscriptionRequest[] };
    const userId = getUserId(req);
    const merged = mergeServerFilter(subscriptions, userId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send the initial batch of records since each subscription's last syncToken.
    try {
      const result = await syncHandler.pull(merged);
      res.write(`data: ${JSON.stringify(result)}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }

    // Register this connection for future push notifications.
    const conn: SseConnection = {
      subscriptions: merged.map((s) => ({ key: s.key, filter: s.filter })),
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
    const { records } = req.body as { records: NoteRecord[] };

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
