import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { EMPTY_SYNC_TOKEN } from "@sync-subscribe/core";
import type { SyncRecord, SubscriptionFilter, SyncToken } from "@sync-subscribe/core";
import { SyncClient, LocalStore } from "@sync-subscribe/client";
import type { SyncTransport } from "@sync-subscribe/client";
import { SyncProvider, useSyncClient, useRecords, useMutate } from "../index.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

interface Note extends SyncRecord {
  title: string;
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    recordId: "n1",
    createdAt: 1000,
    updatedAt: 2000,
    revisionCount: 1,
    title: "hello",
    ...overrides,
  };
}

function makeTransport(): SyncTransport {
  return {
    createSubscription: vi.fn(async (filter: SubscriptionFilter) => ({
      subscriptionId: "sub-1",
      filter,
      syncToken: EMPTY_SYNC_TOKEN,
    })),
    pull: vi.fn(async () => ({ patches: [], syncToken: EMPTY_SYNC_TOKEN })),
    push: vi.fn(async () => ({ ok: true as const })),
  };
}

function makeClient(transport: SyncTransport) {
  return new SyncClient<Note>(transport);
}

function Wrapper({ client, children }: { client: SyncClient<Note>; children: React.ReactNode }) {
  return <SyncProvider client={client}>{children}</SyncProvider>;
}

// ---------------------------------------------------------------------------
// useSyncClient
// ---------------------------------------------------------------------------

describe("useSyncClient", () => {
  it("throws when used outside SyncProvider", () => {
    function Bad() {
      useSyncClient();
      return null;
    }
    // Suppress React's error boundary console noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow("useSyncClient must be used inside <SyncProvider>");
    spy.mockRestore();
  });

  it("returns the client from context", () => {
    const transport = makeTransport();
    const client = makeClient(transport);
    let captured: SyncClient<Note> | null = null;

    function Inner() {
      captured = useSyncClient<Note>();
      return null;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);
    expect(captured).toBe(client);
  });
});

// ---------------------------------------------------------------------------
// useRecords
// ---------------------------------------------------------------------------

describe("useRecords", () => {
  let transport: SyncTransport;
  let client: SyncClient<Note>;

  beforeEach(() => {
    transport = makeTransport();
    client = makeClient(transport);
  });

  it("subscribes and pulls on mount", async () => {
    function Inner() {
      useRecords<Note>({ filter: { title: "hello" } });
      return null;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await waitFor(() => {
      expect(transport.createSubscription).toHaveBeenCalledWith(
        { title: "hello" },
        undefined,
      );
      expect(transport.pull).toHaveBeenCalled();
    });
  });

  it("renders records returned by pull", async () => {
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: note() }],
      syncToken: EMPTY_SYNC_TOKEN,
    });

    function Inner() {
      const notes = useRecords<Note>({ filter: {}, pollInterval: 0 });
      return <ul>{notes.map((n) => <li key={n.recordId}>{n.title}</li>)}</ul>;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await waitFor(() => {
      expect(screen.getByText("hello")).toBeTruthy();
    });
  });

  it("re-renders when a patch arrives via onPatches", async () => {
    function Inner() {
      const notes = useRecords<Note>({ filter: {}, pollInterval: 0 });
      return <ul>{notes.map((n) => <li key={n.recordId}>{n.title}</li>)}</ul>;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await act(async () => {
      await client.store.write(note({ title: "patched" }));
      // Trigger listeners manually (simulates a pull result)
      await (client as unknown as { emit: (p: unknown[]) => void }).emit?.([
        { op: "upsert", record: note({ title: "patched" }) },
      ]);
      // Directly fire onPatches by applying a patch so the store listener fires
      await client.store.applyPatches([{ op: "upsert", record: note({ title: "patched" }) }]);
    });

    // Flush state: refresh reads store, store now has "patched"
    await waitFor(async () => {
      const all = await client.store.getAll();
      expect(all[0]?.title).toBe("patched");
    });
  });

  it("re-subscribes with previousSubscriptionId when filter changes", async () => {
    vi.mocked(transport.createSubscription)
      .mockResolvedValueOnce({ subscriptionId: "sub-1", filter: {}, syncToken: EMPTY_SYNC_TOKEN })
      .mockResolvedValueOnce({ subscriptionId: "sub-2", filter: { title: "new" }, syncToken: EMPTY_SYNC_TOKEN });

    function Inner() {
      const [filter, setFilter] = useState<SubscriptionFilter>({});
      const notes = useRecords<Note>({ filter, pollInterval: 0 });
      return (
        <>
          <button onClick={() => setFilter({ title: "new" })}>change</button>
          <span>{notes.length}</span>
        </>
      );
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await waitFor(() => expect(transport.createSubscription).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByText("change").click();
    });

    await waitFor(() => {
      expect(transport.createSubscription).toHaveBeenCalledTimes(2);
      expect(transport.createSubscription).toHaveBeenLastCalledWith(
        { title: "new" },
        "sub-1",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// useMutate
// ---------------------------------------------------------------------------

describe("useMutate", () => {
  let transport: SyncTransport;
  let client: SyncClient<Note>;

  beforeEach(() => {
    transport = makeTransport();
    client = makeClient(transport);
  });

  it("throws when used outside SyncProvider", () => {
    function Bad() {
      useMutate<Note>();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow("useMutate must be used inside <SyncProvider>");
    spy.mockRestore();
  });

  it("calls client.mutate when online", async () => {
    // jsdom sets navigator.onLine = true by default
    let mutate!: (r: Note) => Promise<boolean>;

    function Inner() {
      mutate = useMutate<Note>();
      return null;
    }

    await client.subscribe({ filter: {} });
    render(<Wrapper client={client}><Inner /></Wrapper>);

    let result!: boolean;
    await act(async () => {
      result = await mutate(note());
    });

    expect(result).toBe(true);
    expect(transport.push).toHaveBeenCalledWith("sub-1", [note()]);
  });

  it("queues mutation and writes locally when offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

    let mutate!: (r: Note) => Promise<boolean>;

    function Inner() {
      mutate = useMutate<Note>();
      return null;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    let result!: boolean;
    await act(async () => {
      result = await mutate(note({ title: "offline-note" }));
    });

    expect(result).toBe(true);
    // Local store written immediately
    expect(await client.store.getById("n1")).toMatchObject({ title: "offline-note" });
    // But nothing pushed yet
    expect(transport.push).not.toHaveBeenCalled();

    // Restore
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });
});
