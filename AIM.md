# Goal

- The aim of this project is to create an offline sync service for applications
- The front-end is always typescript
- The back-end is agnostic, though we should do our examples in typescript for now
- We want to take inspiration from rxdb, replicache and similar projects

## What makes this unique

- Instead of pulling entire databases/tables from the server to the client, we want subsets
- This is the idea of "subscriptions" which are filter based definitions
  - The filters are based on properties of the object. Eg. `isDeleted`, `createdAt`, `objectType`.
- "Subscriptions" could overlap each other
  - Ideally we don't duplicate that data on the client side
- A server side is able to add filters to a subscription request, eg. filter to accountId
  - The client is unaware of these additions as they may be sensitive
  - The `clientFilter` is a subset of the `serverFilter`: the server merges its additions into the client's filter, so `clientFilter ⊆ serverFilter`
- The server then keeps track of thoses subscriptions for a client
- When data changes the server needs to know if a filter is invalidated and push that data to the client
  - (or let the client pull it)
- A subscription filter can update, for example a rolling time window.
  - The client should evict stale data (not delete it)
    - Note: the data does not get evicted if another subscription needs it, by comparing against its filter definition.
  - The server should sync in new data that is now available
    - It will also compare the old filter to the new filter to find what data has not yet been synced.
    - The server should decide if it wants to full sync, or partial sync when a subscription is updated


## Notes
- Conflict resolution is done via the server by default
  - The highest `revisionCount` (aka work done) wins, on tie, the older `updatedAt` wins.
  - If the client `push` results in a conflict, the updated record will be returned
  - `revisionCount` in incremented on server/client. whenever a record is modified its count is updated. `revisionCount` is a "temporal work indicator" that doesn't care about clocks. Its a measurement of work done.
- When upgrading data models, the client can set a default, but that won't force a "push"
  - Server needs to be backwards compatible, clients don't need to be.
- endpoints
  - Our server can use SSE to push changes to the client on a `sync` endpoint
    - The client sends its `syncToken` for each subscription
    - The `syncToken` is a combination of `updatedAt,revisionCount,recordId` where recordId is the unique id of a tables record
      - The `syncToken` is opaque to the client
  - The client can `pull` (get) and `push` (post)
    - The `syncToken` is sent for all `pulls`. The 1st pull is an empty `syncToken`
    - Only records that have been modified by the client are pushed on a `push`
  - The client sends its subscription id's for each request
  - When creating a subscription (`put`) the client can specify the old subscription, or just ask for a new one
- The client keeps the `subscriptionId`, `filter` and `syncToken` for each subscription.
  - It also needs to know the datamodel for it, though that can be defined in the client
  - The `syncToken` is 1 per subscription
  - On subscription update, the server may give a new `syncToken`
- The server can define some fields as `readonly` that the client cannot modify
  - any changes to these fields by the client do not result in a push, and if they do get pushed, the server ignores them
- We should use an `updatedAt` timestamp and `revisionCount` to keep track of versions and conflicts
  - The server will uses these two fields to know what data is new, vs stale
- Client will be able to read its own writes immediately, it doesn't need to wait for a push
  - If the server pushes to the client, and a conflict is encountered (by revisionCount) the server value is used. or the client pushes if its more valid
- The client stores the `updatedAt` in its own local time. The server stores its `updatedAt` in its server synchronized timestamp. Same for `createdAt`.
  - this helps each identify which is new vs old data
  - the `syncToken` is server generated, never client generated
- Every record in a database needs a `updatedAt`, `createdAt`, `revisionCount`, and a `recordId` (though the later can be named appropriate to the table itself)


## TODO

Here's what's still missing

  ---
  packages/client/

  1. No resetRequired handling (AIM.md: "The client should evict stale data")
  SyncClient.subscribe calls transport.createSubscription but ignores the resetRequired flag in the response. When a filter changes, stale records are never evicted from LocalStore.

  2. No eviction logic in LocalStore (AIM.md: "The data does not get evicted if another subscription needs it, by comparing against its filter definition")
  LocalStore has no evict(filter) method. Eviction requires checking each local record against all active subscriptions — records only get removed if no remaining subscription's filter
   covers them.

  3. No SSE/streaming support on SyncTransport (AIM.md: "Our server can use SSE to push changes to the client")
  SyncTransport only has pull (polling). There's no stream(subscriptionId, syncToken, onPatches) method, so clients can only poll.

  4. No subscription update method on SyncClient (AIM.md: "A subscription filter can update, for example a rolling time window")
  There's no SyncClient.updateSubscription(id, newFilter) method. The subscribe method always creates new subscriptions — it doesn't wire up previousSubscriptionId to trigger
  resetRequired handling or eviction.

  5. No offline push queue (AIM.md: "Only records that have been modified by the client are pushed on a push")
  If mutate() is called while offline the push throws and the change is effectively lost. There's no queue that retries pending pushes when connectivity resumes.

  Summary table

  ┌─────┬─────────┬─────────────────────────────────────────────┬──────────┐
  │  #  │ Package │                   Missing                   │ Priority │
  ├─────┼─────────┼─────────────────────────────────────────────┼──────────┤
  │ 1   │ client  │ resetRequired handling on subscribe/update  │ High     │
  ├─────┼─────────┼─────────────────────────────────────────────┼──────────┤
  │ 2   │ client  │ LocalStore.evict(filter, allFilters)        │ High     │
  ├─────┼─────────┼─────────────────────────────────────────────┼──────────┤
  │ 3   │ client  │ SSE transport method + SyncClient streaming │ High     │
  ├─────┼─────────┼─────────────────────────────────────────────┼──────────┤
  │ 4   │ client  │ SyncClient.updateSubscription()             │ Medium   │
  ├─────┼─────────┼─────────────────────────────────────────────┼──────────┤
  │ 5   │ client  │ Offline push queue                          │ Low      │
  └─────┴─────────┴─────────────────────────────────────────────┴──────────┘

  Done:
  ✓ 6  server  SubscriptionStore persistence interface + InMemorySubscriptionStore
  ✓ 7  server  Partial sync diff on filter update — SyncStore.computePartialSyncToken?() interface
               + SyncHandler.updateSubscription() orchestrates it with full-reset fallback
  ✓ 8  server  SyncHandler.serverUpsert()
  ✓ 9  core    matchesFilter moved to packages/core (re-exported from server for compat)
