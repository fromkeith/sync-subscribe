<script lang="ts">
  import type { NoteRecord } from "../types.js";
  import { COLOR_HEX } from "../types.js";

  let { note, onDelete }: { note: NoteRecord; onDelete: (note: NoteRecord) => void } = $props();

  function timeAgo(ms: number): string {
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return "just now";
  }

  const accent = $derived(note.color ? (COLOR_HEX[note.color] ?? "#94a3b8") : "#94a3b8");

  let deleteHover = $state(false);
</script>

<div
  style="background: #fff; border-radius: 12px; padding: 16px; border: 2px solid {accent}22; border-top: 4px solid {accent}; box-shadow: 0 1px 3px rgba(0,0,0,0.06); display: flex; flex-direction: column; gap: 8px; position: relative;"
>
  <!-- Color + category row -->
  <div style="display: flex; align-items: center; gap: 8px;">
    {#if note.color}
      <span
        style="width: 10px; height: 10px; border-radius: 50%; background: {accent}; flex-shrink: 0;"
      ></span>
    {/if}
    {#if note.category}
      <span
        style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8;"
      >{note.category}</span>
    {/if}
    <span style="margin-left: auto; font-size: 11px; color: #cbd5e1;">rev {note.revisionCount}</span>
  </div>

  <!-- Title -->
  <h3
    style="font-size: 15px; font-weight: 600; font-family: {note.fontFamily ?? 'inherit'}; color: #1e293b;"
  >
    {note.title || "(untitled)"}
  </h3>

  <!-- Contents -->
  {#if note.contents}
    <p
      style="font-size: 13px; color: #64748b; line-height: 1.5; font-family: {note.fontFamily ?? 'inherit'}; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;"
    >
      {note.contents}
    </p>
  {/if}

  <!-- Footer -->
  <div
    style="display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: 8px; border-top: 1px solid #f1f5f9;"
  >
    <span style="font-size: 11px; color: #cbd5e1;">{timeAgo(note.createdAt)}</span>
    <button
      onclick={() => onDelete(note)}
      onmouseenter={() => (deleteHover = true)}
      onmouseleave={() => (deleteHover = false)}
      style="background: none; border: none; cursor: pointer; color: {deleteHover
        ? '#ef4444'
        : '#cbd5e1'}; font-size: 13px; padding: 2px 6px; border-radius: 6px;"
      title="Delete note"
    >
      ✕
    </button>
  </div>
</div>
