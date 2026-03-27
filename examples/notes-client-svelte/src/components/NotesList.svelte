<script lang="ts">
  import type { NoteRecord } from "../types.js";
  import NoteCard from "./NoteCard.svelte";

  let { notes, onDelete }: { notes: NoteRecord[]; onDelete: (note: NoteRecord) => void } =
    $props();

  const notesSorted = $derived([...notes].sort((a, b) => b.createdAt - a.createdAt));
</script>

{#if notes.length === 0}
  <div style="text-align: center; padding: 64px 0; color: #94a3b8; font-size: 15px;">
    No notes yet. Create one above.
  </div>
{:else}
  <div
    style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;"
  >
    {#each notesSorted as note (note.recordId)}
      <NoteCard {note} {onDelete} />
    {/each}
  </div>
{/if}
