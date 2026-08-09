<script lang="ts">
  // Template gallery (plan Task 16): built-ins + user templates for one
  // enabled grid. Apply lays the grid out per the template (brain
  // `applyTemplate` via `settings-apply-template`), Capture snapshots the
  // current layout under a user-chosen name (`settings-capture-template`),
  // and non-builtin templates can be deleted (`settings-delete-template`,
  // two-click arm instead of a native confirm — WebView2 dialogs are
  // disabled). Persistence is automatic: every brain snapshot schedules a
  // write_config save in the brain host.
  import type { Template } from '@griddle-wm/brain';
  import {
    emitSettingsApplyTemplate,
    emitSettingsCaptureTemplate,
    emitSettingsDeleteTemplate,
  } from '../../lib/ipc';

  interface Props {
    gridId: string;
    templates: Template[];
    activeTemplateId: string | null;
    /** Windows currently tiled on this grid (capture needs at least one). */
    tileCount: number;
  }
  const { gridId, templates, activeTemplateId, tileCount }: Props = $props();

  const MAX_NAME_LEN = 40;

  // ── capture (inline name prompt) ─────────────────────────────────────────
  let capturing = $state(false);
  let captureName = $state('');
  let nameInput: HTMLInputElement | null = $state(null);

  const trimmedName = $derived(captureName.trim().slice(0, MAX_NAME_LEN));

  function startCapture(): void {
    capturing = true;
    captureName = '';
    // Focus once the input exists in the DOM.
    queueMicrotask(() => nameInput?.focus());
  }

  function cancelCapture(): void {
    capturing = false;
    captureName = '';
  }

  function saveCapture(): void {
    if (trimmedName.length === 0) return;
    void emitSettingsCaptureTemplate({ gridId, name: trimmedName });
    cancelCapture();
  }

  function onNameKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') saveCapture();
    else if (e.key === 'Escape') cancelCapture();
  }

  // ── apply / delete ───────────────────────────────────────────────────────
  function apply(t: Template): void {
    void emitSettingsApplyTemplate({ gridId, templateId: t.id });
  }

  // Delete is armed per template id and disarms after a moment, so a stray
  // click never destroys a template silently.
  let armedDeleteId: string | null = $state(null);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  function requestDelete(t: Template): void {
    if (t.builtin) return;
    if (armedDeleteId === t.id) {
      if (disarmTimer !== null) clearTimeout(disarmTimer);
      disarmTimer = null;
      armedDeleteId = null;
      void emitSettingsDeleteTemplate({ templateId: t.id });
      return;
    }
    armedDeleteId = t.id;
    if (disarmTimer !== null) clearTimeout(disarmTimer);
    disarmTimer = setTimeout(() => {
      armedDeleteId = null;
      disarmTimer = null;
    }, 2500);
  }

  // ── preview drawing ──────────────────────────────────────────────────────
  /** Slot rects in a unit-per-cell viewBox, slightly inset for a gap. */
  function slotRects(t: Template) {
    const inset = 0.06 * Math.max(t.cols, t.rows);
    return t.slots.map((s) => ({
      x: s.col + inset,
      y: s.row + inset,
      w: Math.max(s.w - 2 * inset, 0.1),
      h: Math.max(s.h - 2 * inset, 0.1),
    }));
  }
</script>

<div class="gallery">
  <div class="gallery-head">
    <span class="lbl">Templates (shared across grids)</span>
    {#if capturing}
      <div class="capture-form">
        <input
          bind:this={nameInput}
          bind:value={captureName}
          type="text"
          maxlength={MAX_NAME_LEN}
          placeholder="Template name"
          onkeydown={onNameKeydown}
        />
        <button
          class="btn primary"
          disabled={trimmedName.length === 0}
          onclick={saveCapture}>Save</button
        >
        <button class="btn" onclick={cancelCapture}>Cancel</button>
      </div>
    {:else}
      <button
        class="btn"
        disabled={tileCount === 0}
        title={tileCount === 0
          ? 'No windows on this grid to capture'
          : 'Save the current layout as a template'}
        onclick={startCapture}>Capture layout</button
      >
    {/if}
  </div>

  <div class="cards">
    {#each templates as t (t.id)}
      {@const active = t.id === activeTemplateId}
      <div class="tcard" class:active>
        <svg
          class="preview"
          viewBox="0 0 {t.cols} {t.rows}"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {#each slotRects(t) as r}
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={0.04 * Math.max(t.cols, t.rows)} />
          {/each}
        </svg>
        <div class="tinfo">
          <span class="tname" title={t.name}>{t.name}</span>
          <span class="tmeta">
            {t.cols}×{t.rows} · {t.slots.length}
            {t.slots.length === 1 ? 'slot' : 'slots'}
            {#if t.builtin}· built-in{/if}
          </span>
        </div>
        <div class="tactions">
          <button class="btn primary" onclick={() => apply(t)}>
            {active ? 'Reapply' : 'Apply'}
          </button>
          {#if !t.builtin}
            <button
              class="btn danger"
              class:armed={armedDeleteId === t.id}
              aria-label={armedDeleteId === t.id
                ? `Confirm deleting template ${t.name}`
                : `Delete template ${t.name}`}
              onclick={() => requestDelete(t)}
            >
              {armedDeleteId === t.id ? 'Sure?' : 'Delete'}
            </button>
          {/if}
        </div>
        {#if active}<span class="active-dot" title="Last applied to this grid"></span>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .gallery {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .gallery-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 28px;
  }
  .lbl {
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .capture-form {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .capture-form input {
    width: 180px;
    height: 28px;
    box-sizing: border-box;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--well);
    color: var(--text-strong);
    font: 13px/1 var(--sans);
    -webkit-user-select: text;
    user-select: text;
  }
  .capture-form input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .btn {
    height: 28px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--well);
    color: var(--text);
    font: 600 12px/1 var(--sans);
    cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: rgba(139, 124, 246, 0.12);
    color: var(--text-strong);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn.primary {
    background: rgba(139, 124, 246, 0.16);
    border-color: rgba(139, 124, 246, 0.45);
    color: var(--accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: rgba(139, 124, 246, 0.28);
    color: #a99dfa;
  }
  .btn.danger:hover:not(:disabled),
  .btn.danger.armed {
    border-color: rgba(245, 101, 101, 0.6);
    background: rgba(245, 101, 101, 0.12);
    color: #f56565;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: 10px;
  }

  .tcard {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--well);
    transition: border-color 0.12s ease;
  }
  .tcard:hover {
    border-color: rgba(139, 124, 246, 0.45);
  }
  .tcard.active {
    border-color: var(--accent);
  }

  .preview {
    width: 100%;
    height: 56px;
    display: block;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
  }
  .preview rect {
    fill: rgba(139, 124, 246, 0.28);
    stroke: rgba(139, 124, 246, 0.75);
    stroke-width: 0.6%;
    vector-effect: non-scaling-stroke;
  }

  .tinfo {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .tname {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tmeta {
    font-size: 11px;
    color: var(--text-dim);
  }

  .tactions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: auto;
  }

  .active-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px rgba(139, 124, 246, 0.8);
  }
</style>
