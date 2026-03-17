import type Database from "better-sqlite3";
import type { SubscriptionStore, ServerSubscription } from "@sync-subscribe/server";
import type { SyncToken, SubscriptionFilter } from "@sync-subscribe/core";

interface SubscriptionRow {
  subscriptionId: string;
  clientFilter: string;
  serverFilter: string;
  filter: string;
  syncToken: string;
}

function rowToSub(row: SubscriptionRow): ServerSubscription {
  return {
    subscriptionId: row.subscriptionId,
    clientFilter: JSON.parse(row.clientFilter) as SubscriptionFilter,
    serverFilter: JSON.parse(row.serverFilter) as SubscriptionFilter,
    filter: JSON.parse(row.filter) as SubscriptionFilter,
    syncToken: row.syncToken as SyncToken,
  };
}

export class SqliteSubscriptionStore implements SubscriptionStore {
  constructor(private readonly db: Database.Database) {}

  async save(sub: ServerSubscription): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO subscriptions (subscriptionId, clientFilter, serverFilter, filter, syncToken)
         VALUES (@subscriptionId, @clientFilter, @serverFilter, @filter, @syncToken)
         ON CONFLICT(subscriptionId) DO UPDATE SET
           clientFilter = excluded.clientFilter,
           serverFilter = excluded.serverFilter,
           filter       = excluded.filter,
           syncToken    = excluded.syncToken`,
      )
      .run({
        subscriptionId: sub.subscriptionId,
        clientFilter: JSON.stringify(sub.clientFilter),
        serverFilter: JSON.stringify(sub.serverFilter),
        filter: JSON.stringify(sub.filter),
        syncToken: sub.syncToken,
      });
  }

  async get(subscriptionId: string): Promise<ServerSubscription | undefined> {
    const row = this.db
      .prepare("SELECT * FROM subscriptions WHERE subscriptionId = ?")
      .get(subscriptionId) as SubscriptionRow | undefined;
    return row ? rowToSub(row) : undefined;
  }

  async delete(subscriptionId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM subscriptions WHERE subscriptionId = ?")
      .run(subscriptionId);
  }

  async getAll(): Promise<ServerSubscription[]> {
    const rows = this.db
      .prepare("SELECT * FROM subscriptions")
      .all() as SubscriptionRow[];
    return rows.map(rowToSub);
  }
}
