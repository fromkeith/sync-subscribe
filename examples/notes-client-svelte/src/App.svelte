<script lang="ts">
  import {
    clientProviderFactory,
    recentQueryFactory,
    recentLiveQueryFactory,
    blueNotesFactory,
    mutate,
  } from "./providers.js";
  import type { NoteRecord } from "./types.js";
  import NotesList from "./components/NotesList.svelte";
  import CreateNoteForm from "./components/CreateNoteForm.svelte";

  type Tab = "all" | "recent" | "blue";
  type RecentRange = "1d" | "2d" | "1w" | "1m" | "2m" | "all";

  const DAY = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * DAY;

  const RANGE_MS: Record<RecentRange, number | null> = {
    "1d": 1 * DAY,
    "2d": 2 * DAY,
    "1w": 7 * DAY,
    "1m": 30 * DAY,
    "2m": 60 * DAY,
    all: null,
  };

  const RANGE_LABELS: Record<RecentRange, string> = {
    "1d": "Last day",
    "2d": "Last 2 days",
    "1w": "Last week",
    "1m": "Last month",
    "2m": "Last 2 months",
    all: "All time",
  };

  const TAB_LABEL: Record<Tab, string> = {
    all: "All Local Notes",
    recent: "Recent",
    blue: "Blue Notes",
  };

  const TABS: Tab[] = ["all", "recent", "blue"];
  const RANGE_KEYS = Object.keys(RANGE_LABELS) as RecentRange[];

  let tab = $state<Tab>("recent");
  let recentRange = $state<RecentRange>("1m");
  let showCreate = $state(false);

  // --- Background 7-day sync subscription ---
  // Keeps the last 7 days in the local store without loading into memory.
  // recentQueryFactory / recentLiveQueryFactory handle the reactive display.
  $effect(() => {
    let cancelled = false;
    let subId: string | undefined;
    const filter = { createdAt: { $gte: Date.now() - SEVEN_DAYS } };

    clientProviderFactory().promise.then((client) => {
      if (cancelled) return;
      void client.subscribe({ filter, name: "recent-7d-sync" }).then((sub) => {
        if (cancelled) void client.unsubscribe(sub.subscriptionId);
        else subId = sub.subscriptionId;
      });
    });

    return () => {
      cancelled = true;
      if (subId !== undefined) {
        clientProviderFactory().promise.then((client) => {
          void client.unsubscribe(subId!);
          subId = undefined;
        });
      }
    };
  });

  // --- Derived filter state ---
  const cutoff = $derived(RANGE_MS[recentRange] !== null ? Date.now() - RANGE_MS[recentRange]! : null);
  const recentFilter = $derived(cutoff !== null ? { createdAt: { $gte: cutoff } } : {});
  const withinSyncWindow = $derived(
    RANGE_MS[recentRange] !== null && RANGE_MS[recentRange]! <= SEVEN_DAYS,
  );

  // --- Recent notes ---
  // Within 7 days: local-store query only (background subscription keeps it fresh).
  // Beyond 7 days: live query registers its own sync subscription on demand.
  let recentNotes = $state<NoteRecord[]>([]);
  let recentLoading = $state(true);

  $effect(() => {
    const filter = recentFilter;
    const q = withinSyncWindow
      ? recentQueryFactory({ filter })
      : recentLiveQueryFactory({ filter });
    return q.subscribe((value) => {
      if (value) {
        recentNotes = value.data;
        recentLoading = value.loading;
      }
    });
  });

  // --- Blue notes ---
  let blueNotes = $state<NoteRecord[]>([]);
  let blueLoading = $state(true);

  $effect(() => {
    const q = blueNotesFactory({ filter: { color: "blue" }, name: "blue-notes" });
    return q.subscribe((value) => {
      if (value) {
        blueNotes = value.data;
        blueLoading = value.loading;
      }
    });
  });

  // --- Derived combined state ---
  const allNotes = $derived.by(() => {
    const map = new Map<string, NoteRecord>();
    for (const n of [...recentNotes, ...blueNotes]) {
      if (!n.isDeleted) map.set(n.recordId, n);
    }
    return [...map.values()];
  });

  const visibleNotes = $derived.by(() => {
    if (tab === "recent") return recentNotes.filter((n) => !n.isDeleted);
    if (tab === "blue") return blueNotes.filter((n) => !n.isDeleted);
    return allNotes;
  });

  const loading = $derived(recentLoading || blueLoading);

  function countFor(t: Tab): number {
    if (t === "recent") return recentNotes.filter((n) => !n.isDeleted).length;
    if (t === "blue") return blueNotes.filter((n) => !n.isDeleted).length;
    return allNotes.length;
  }

  function isLiveRange(r: RecentRange): boolean {
    return RANGE_MS[r] === null || (RANGE_MS[r] as number) > SEVEN_DAYS;
  }

  async function handleCreate(
    data: Omit<NoteRecord, "recordId" | "createdAt" | "updatedAt" | "revisionCount" | "userId">,
  ) {
    await mutate({
      recordId: crypto.randomUUID(),
      userId: "user-123",
      createdAt: Date.now(),
      ...data,
    } as NoteRecord);
    showCreate = false;
  }

  async function handleDelete(note: NoteRecord) {
    await mutate({ ...note, isDeleted: true });
  }

  const tabMarginBottom = $derived(tab === "recent" ? "12px" : "20px");
</script>

<div style="max-width: 960px; margin: 0 auto; padding: 24px 16px;">
  <!-- Header -->
  <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 24px;">
    <h1 style="font-size: 24px; font-weight: 700; flex: 1;">Notes</h1>
    <button
      onclick={() => (showCreate = true)}
      style="background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-weight: 600; font-size: 14px;"
    >
      + New note
    </button>
  </div>

  <!-- Tab buttons -->
  <div style="display: flex; gap: 4px; margin-bottom: {tabMarginBottom};">
    {#each TABS as t (t)}
      <button
        onclick={() => (tab = t)}
        style="padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; font-weight: {tab ===
        t
          ? 600
          : 400}; background: {tab === t ? '#1e293b' : '#e2e8f0'}; color: {tab === t
          ? '#fff'
          : '#475569'}; font-size: 14px; transition: all 0.15s;"
      >
        {TAB_LABEL[t]}
        <span
          style="margin-left: 8px; background: {tab === t
            ? 'rgba(255,255,255,0.2)'
            : '#cbd5e1'}; color: {tab === t ? '#fff' : '#475569'}; border-radius: 9999px; padding: 1px 7px; font-size: 11px;"
        >
          {countFor(t)}
        </span>
      </button>
    {/each}
  </div>

  <!-- Recent range selector — only visible on the recent tab -->
  {#if tab === "recent"}
    <div style="display: flex; gap: 4px; margin-bottom: 20px;">
      {#each RANGE_KEYS as r (r)}
        <button
          onclick={() => (recentRange = r)}
          style="padding: 5px 12px; border: 1.5px solid {recentRange === r
            ? '#3b82f6'
            : '#e2e8f0'}; border-radius: 6px; cursor: pointer; font-weight: {recentRange === r
            ? 600
            : 400}; background: {recentRange === r
            ? '#eff6ff'
            : '#fff'}; color: {recentRange === r ? '#2563eb' : '#64748b'}; font-size: 12px; transition: all 0.15s;"
        >
          {RANGE_LABELS[r]}
          {#if isLiveRange(r)}
            <span style="margin-left: 5px; font-size: 10px; opacity: 0.6; font-weight: 400;"
              >live</span
            >
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Notes grid -->
  {#if loading}
    <p style="color: #94a3b8; font-size: 14px;">Loading…</p>
  {:else}
    <NotesList notes={visibleNotes} onDelete={handleDelete} />
  {/if}

  <!-- Create modal -->
  {#if showCreate}
    <CreateNoteForm onSubmit={handleCreate} onCancel={() => (showCreate = false)} />
  {/if}
</div>
