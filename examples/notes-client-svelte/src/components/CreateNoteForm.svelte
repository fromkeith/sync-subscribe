<script lang="ts">
  import type { NoteRecord } from "../types.js";
  import { COLORS, COLOR_HEX, FONT_FAMILIES } from "../types.js";

  type CreateData = Omit<
    NoteRecord,
    "recordId" | "createdAt" | "updatedAt" | "revisionCount" | "userId"
  >;

  let { onSubmit, onCancel }: { onSubmit: (data: CreateData) => void; onCancel: () => void } =
    $props();

  let title = $state("");
  let contents = $state("");
  let color = $state<string | null>(null);
  let category = $state("");
  let fontFamily = $state<string | null>(null);

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    onSubmit({ title, contents, color, category: category || null, fontFamily, isDeleted: false });
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }

  const colorOptions = [null, ...COLORS] as const;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  onclick={handleOverlayClick}
  style="position: fixed; inset: 0; background: rgba(15,23,42,0.5); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 16px;"
>
  <form
    onsubmit={handleSubmit}
    style="background: #fff; border-radius: 16px; padding: 24px; width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.2);"
  >
    <h2 style="font-size: 18px; font-weight: 700; color: #1e293b;">New note</h2>

    <div style="display: flex; flex-direction: column; gap: 4px;">
      <label for="note-title" style="font-size: 13px; font-weight: 600; color: #475569;">Title</label>
      <input
        id="note-title"
        bind:value={title}
        placeholder="Note title"
        required
        style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 14px; outline: none; font-family: inherit;"
      />
    </div>

    <div style="display: flex; flex-direction: column; gap: 4px;">
      <label for="note-contents" style="font-size: 13px; font-weight: 600; color: #475569;">Contents</label>
      <textarea
        id="note-contents"
        bind:value={contents}
        placeholder="Write something…"
        style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 14px; outline: none; font-family: inherit; min-height: 100px; resize: vertical;"
      ></textarea>
    </div>

    <div style="display: flex; gap: 12px;">
      <!-- Color -->
      <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label style="font-size: 13px; font-weight: 600; color: #475569;">Color</label>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          {#each colorOptions as c (c ?? "none")}
            <button
              type="button"
              onclick={() => (color = c ?? null)}
              title={c ?? "none"}
              style="width: 28px; height: 28px; border-radius: 50%; border: {color === (c ?? null)
                ? '3px solid #1e293b'
                : '2px solid #e2e8f0'}; background: {c ? (COLOR_HEX[c] ?? '#e2e8f0') : '#e2e8f0'}; cursor: pointer;"
            ></button>
          {/each}
        </div>
      </div>

      <!-- Category -->
      <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
        <label for="note-category" style="font-size: 13px; font-weight: 600; color: #475569;">Category</label>
        <input
          id="note-category"
          bind:value={category}
          placeholder="e.g. work, ideas"
          style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 14px; outline: none; font-family: inherit;"
        />
      </div>
    </div>

    <!-- Font family -->
    <div style="display: flex; flex-direction: column; gap: 4px;">
      <label for="note-font" style="font-size: 13px; font-weight: 600; color: #475569;">Font family</label>
      <select
        id="note-font"
        value={fontFamily ?? ""}
        onchange={(e) => (fontFamily = (e.currentTarget as HTMLSelectElement).value || null)}
        style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 14px; outline: none; font-family: inherit;"
      >
        <option value="">Default</option>
        {#each FONT_FAMILIES as f (f)}
          <option value={f} style="font-family: {f};">{f}</option>
        {/each}
      </select>
    </div>

    <!-- Actions -->
    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button
        type="button"
        onclick={onCancel}
        style="padding: 8px 20px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; cursor: pointer; font-size: 14px;"
      >
        Cancel
      </button>
      <button
        type="submit"
        style="padding: 8px 20px; border: none; border-radius: 8px; background: #3b82f6; color: #fff; cursor: pointer; font-weight: 600; font-size: 14px;"
      >
        Create
      </button>
    </div>
  </form>
</div>
