import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, within } from "@testing-library/react";
import React, { useMemo, useState } from "react";
import type { SyncRecord, SubscriptionFilter } from "@sync-subscribe/core";
import { SyncClient } from "@sync-subscribe/client";
import type { SyncTransport, SyncQuery, QueryEntries } from "@sync-subscribe/client";
import { SyncProvider, useSyncClient, useRecords, useMutate, useQuery } from "../index.js";

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
    pull: vi.fn(async () => ({ patches: [], syncTokens: {} })),
    push: vi.fn(async () => ({ ok: true as const, serverUpdatedAt: 3000 })),
  };
}

function makeClient(transport: SyncTransport) {
  return new SyncClient<Note>(transport);
}

function Wrapper({ client, children }: { client: SyncClient<Note>; children: React.ReactNode }) {
  return <SyncProvider client={client}>{children}</SyncProvider>;
}

const flushPromises = () => new Promise<void>((r) => setTimeout(r, 0));

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

  it("subscribes locally and pulls on mount", async () => {
    function Inner() {
      useRecords<Note>({ filter: { title: "hello" } });
      return null;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await waitFor(() => {
      expect(transport.pull).toHaveBeenCalled();
    });

    const pullArg = vi.mocked(transport.pull).mock.calls[0]![0];
    expect(pullArg[0]).toMatchObject({ filter: { title: "hello" } });
  });

  it("starts with loading: true and becomes false after pull", async () => {
    let capturedLoading: boolean | undefined;

    function Inner() {
      const { loading } = useRecords<Note>({ filter: {} });
      capturedLoading = loading;
      return <span>{loading ? "loading" : "done"}</span>;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);
    expect(capturedLoading).toBe(true);

    await waitFor(() => {
      expect(screen.getByText("done")).toBeTruthy();
    });
    expect(capturedLoading).toBe(false);
  });

  it("renders records returned by pull", async () => {
    vi.mocked(transport.pull).mockResolvedValueOnce({
      patches: [{ op: "upsert", record: note() }],
      syncTokens: {},
    });

    function Inner() {
      const { data: notes } = useRecords<Note>({ filter: {} });
      return <ul>{notes.map((n) => <li key={n.recordId}>{n.title}</li>)}</ul>;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await waitFor(() => {
      expect(screen.getByText("hello")).toBeTruthy();
    });
  });

  it("re-renders when a patch arrives via onPatches", async () => {
    function Inner() {
      const { data: notes } = useRecords<Note>({ filter: {} });
      return <ul>{notes.map((n) => <li key={n.recordId}>{n.title}</li>)}</ul>;
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await act(async () => {
      await client.store.applyPatches([{ op: "upsert", record: note({ title: "patched" }) }]);
      await flushPromises();
    });

    await waitFor(() => {
      expect(screen.getByText("patched")).toBeTruthy();
    });
  });

  it("re-subscribes when filter changes and issues a new pull", async () => {
    function Inner() {
      const [filter, setFilter] = useState<SubscriptionFilter>({});
      const { data: notes } = useRecords<Note>({ filter });
      return (
        <>
          <button onClick={() => setFilter({ title: "new" })}>change</button>
          <span data-testid="count">{notes.length}</span>
        </>
      );
    }

    render(<Wrapper client={client}><Inner /></Wrapper>);

    await waitFor(() => expect(transport.pull).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByText("change").click();
    });

    await waitFor(() => {
      expect(transport.pull).toHaveBeenCalledTimes(2);
    });

    const secondPullArg = vi.mocked(transport.pull).mock.calls[1]![0];
    expect(secondPullArg[0]).toMatchObject({ filter: { title: "new" } });
  });
});

// ---------------------------------------------------------------------------
// useQuery
// ---------------------------------------------------------------------------

describe("useQuery", () => {
  it("starts with loading: true", () => {
    let subscriber: ((value: QueryEntries<Note>) => void) | undefined;
    const mockQuery: SyncQuery<Note> = {
      subscribe(run) {
        subscriber = run;
        // Don't emit anything yet — simulate async load
        return () => { subscriber = undefined; };
      },
    };

    let capturedState: QueryEntries<Note> | undefined;
    function Inner() {
      const q = useMemo(() => mockQuery, []);
      capturedState = useQuery(q);
      return null;
    }

    render(<Inner />);
    expect(capturedState).toEqual({ data: [], loading: true });
    void subscriber; // prevent unused warning
  });

  it("reflects emitted values from the syncQuery", async () => {
    let emit!: (value: QueryEntries<Note>) => void;
    const mockQuery: SyncQuery<Note> = {
      subscribe(run) {
        emit = run;
        run({ data: [], loading: true });
        return () => {};
      },
    };

    function Inner() {
      const q = useMemo(() => mockQuery, []);
      const { data, loading } = useQuery(q);
      return <span>{loading ? "loading" : data.map((n) => n.title).join(",")}</span>;
    }

    const { container } = render(<Inner />);
    expect(within(container).getByText("loading")).toBeTruthy();

    await act(async () => {
      emit({ data: [note()], loading: false });
    });

    expect(within(container).getByText("hello")).toBeTruthy();
  });

  it("unsubscribes from the syncQuery on unmount", () => {
    const unsubscribe = vi.fn();
    const mockQuery: SyncQuery<Note> = {
      subscribe(run) {
        run({ data: [], loading: false });
        return unsubscribe;
      },
    };

    function Inner() {
      const q = useMemo(() => mockQuery, []);
      useQuery(q);
      return null;
    }

    const { unmount } = render(<Inner />);
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes when syncQuery reference changes", async () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    let emitFirst!: (value: QueryEntries<Note>) => void;
    let emitSecond!: (value: QueryEntries<Note>) => void;

    const query1: SyncQuery<Note> = {
      subscribe(run) { emitFirst = run; run({ data: [], loading: false }); return unsub1; },
    };
    const query2: SyncQuery<Note> = {
      subscribe(run) { emitSecond = run; run({ data: [note()], loading: false }); return unsub2; },
    };

    function Inner({ q }: { q: SyncQuery<Note> }) {
      const { data } = useQuery(q);
      return <span>{data.map((n) => n.title).join(",") || "empty"}</span>;
    }

    const { container, rerender } = render(<Inner q={query1} />);
    expect(within(container).getByText("empty")).toBeTruthy();

    await act(async () => {
      rerender(<Inner q={query2} />);
    });

    expect(unsub1).toHaveBeenCalledTimes(1);
    expect(within(container).getByText("hello")).toBeTruthy();
    void emitFirst; void emitSecond;
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

  it("calls client.mutate when online and pushes the record", async () => {
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
    // mutate stamps updatedAt and revisionCount, so use partial match
    expect(transport.push).toHaveBeenCalledWith([
      expect.objectContaining({ recordId: "n1", title: "hello" }),
    ]);
  });

  it("queues mutation when offline without pushing", async () => {
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
    // Nothing pushed yet — will push on drain when back online
    expect(transport.push).not.toHaveBeenCalled();

    // Restore
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("drains queued mutations when back online", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

    let mutate!: (r: Note) => Promise<boolean>;

    function Inner() {
      mutate = useMutate<Note>();
      return null;
    }

    await client.subscribe({ filter: {} });
    render(<Wrapper client={client}><Inner /></Wrapper>);

    await act(async () => {
      await mutate(note({ title: "offline-note" }));
    });

    expect(transport.push).not.toHaveBeenCalled();

    // Simulate going back online
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushPromises();
    });

    expect(transport.push).toHaveBeenCalledWith([
      expect.objectContaining({ recordId: "n1", title: "offline-note" }),
    ]);

    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });
});
