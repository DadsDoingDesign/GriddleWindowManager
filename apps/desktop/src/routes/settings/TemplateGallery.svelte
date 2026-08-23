<script lang="ts">
  // Template gallery (plan Task 16): built-ins + user templates for one
  // enabled grid. Apply lays the grid out per the template (brain
  // `applyTemplate` via `settings-apply-template`), Capture snapshots the
  // current layout under a user-chosen name (`settings-capture-template`),
  // and non-builtin templates can be deleted (`settings-delete-template`,
  // two-click arm instead of a native confirm — WebView2 dialogs are
  // disabled). Persistence is automatic: every brain snapshot schedules a
  // write_config save in the brain host.
  import { templateShape, type Template } from '@griddle-wm/brain';
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
    /** The grid's current dims — Apply discloses when a template differs. */
    gridCols: number;
    gridRows: number;
    /**
     * Laid over the grid map instead of below it, in the map's own box
     * (Figma 110-344 follow-up). The cards flow sideways and the box scrolls
     * horizontally; how many rows fit is decided by the height available, so
     * a tall portrait map gets two and a wide one gets a single strip.
     */
    carousel?: boolean;
  }
  const {
    gridId,
    templates,
    activeTemplateId,
    tileCount,
    gridCols,
    gridRows,
    carousel = false,
  }: Props = $props();

  /**
   * The layout a template actually describes (spec 2026-08-20): "Two
   * columns", authored on the 12×6 lattice so applying it never used to
   * re-dimension a fresh grid, is a 2×1 shape — and the card should say so.
   */
  function shapeOf(t: Template) {
    return templateShape(t);
  }

  /**
   * Applying re-dimensions the grid only when the shape cannot scale into
   * the grid's current dims (brain `applyTemplate`). When it can — 2×1 into
   * 12×6 — the grid keeps its granularity and there is nothing to warn
   * about; when it cannot, the button says what it is about to do at the
   * point of action, not in a README footnote.
   */
  function regrids(t: Template): boolean {
    const shape = shapeOf(t);
    return !(gridCols % shape.cols === 0 && gridRows % shape.rows === 0);
  }

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
    const shape = shapeOf(t);
    const inset = 0.06 * Math.max(shape.cols, shape.rows);
    return shape.slots.map((s) => ({
      x: s.col + inset,
      y: s.row + inset,
      w: Math.max(s.w - 2 * inset, 0.1),
      h: Math.max(s.h - 2 * inset, 0.1),
    }));
  }
</script>

<div class="gallery" class:carousel>
  <div class="gallery-head">
    {#if !carousel}<span class="lbl">Templates</span>{/if}
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

  <div class="cards" data-strip>
    {#each templates as t (t.id)}
      {@const active = t.id === activeTemplateId}
      <!-- One grid track per template. The delete button used to be a sibling
           of the card, which made it a track of its own once the cards flowed
           by column — and, being absolutely positioned with no positioned
           parent of its own, it landed in the corner of the whole strip. -->
      <div class="slot">
      <button
        class="tcard"
        class:active
        title={`${t.name} — ${shapeOf(t).cols}×${shapeOf(t).rows}, ${t.slots.length} ${
          t.slots.length === 1 ? 'slot' : 'slots'
        }${t.builtin ? ', built-in' : ''}. ${
          regrids(t)
            ? `Applying re-dimensions this grid to ${t.cols}×${t.rows}.`
            : `Keeps your ${gridCols}×${gridRows} grid.`
        }`}
        onclick={() => apply(t)}
      >
        <svg
          class="preview"
          viewBox="0 0 {shapeOf(t).cols} {shapeOf(t).rows}"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {#each slotRects(t) as r}
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={0.04 * Math.max(shapeOf(t).cols, shapeOf(t).rows)}
            />
          {/each}
        </svg>
        <span class="tname">
          {t.name}{#if regrids(t)}<span class="regrid" title="Applying changes the grid's dimensions"
              >*</span
            >{/if}
        </span>
      </button>
      {#if !t.builtin}
        <button
          class="tdel"
          class:armed={armedDeleteId === t.id}
          aria-label={armedDeleteId === t.id
            ? `Confirm deleting template ${t.name}`
            : `Delete template ${t.name}`}
          onclick={() => requestDelete(t)}>{armedDeleteId === t.id ? '!' : '×'}</button
        >
      {/if}
      </div>
    {/each}
  </div>
  <p class="hint">Saved templates are shared across all grids.</p>
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
    color: var(--faint);
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--faint);
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
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text);
    font: 13px/1 var(--font-body);
    -webkit-user-select: text;
    user-select: text;
  }
  .capture-form input:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }

  .btn {
    height: 28px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--muted);
    font: 600 12px/1 var(--font-body);
    cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn.primary {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: var(--sp-2);
  }

  /* Carousel: fill the map's box, flow the cards along it, and let the height
     decide the number of rows rather than fixing it. `auto-fill` with a row
     minimum means one strip on a landscape map and two on a tall one, which
     is the "it can be two stacked" case without forcing it into a box too
     short to read. */
  .gallery.carousel {
    height: 100%;
    gap: 8px;
    min-height: 0;
  }
  /* The strip scrolls; the panel never does. `min-width: 0` is what keeps the
     grid's intrinsic width from widening the gallery — and with it the head —
     past the box it is supposed to be scrolling inside. */
  .gallery.carousel {
    width: 100%;
    min-width: 0;
  }
  /* The strip is the scroll box, not the gallery: with the whole gallery
     scrolling, "Capture layout" slid off the left edge and out of reach as
     soon as you moved along the templates. */
  .gallery.carousel .cards {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    /* A default Windows scrollbar is ~17px of a box that is only as tall as
       the map band: left alone it takes the height back out of the very
       cards it exists to reach. */
    scrollbar-width: thin;
    scrollbar-color: var(--line) transparent;
    width: 100%;
    min-width: 0;
    grid-auto-flow: column;
    grid-template-columns: none;
    grid-template-rows: minmax(0, 1fr);
    /* Two and a half at a time. The half is the point: a card cut by the edge
       says "keep going" in a way a row of whole cards and a scrollbar does
       not. Sized off the box rather than fixed in pixels, so the promise holds
       whatever width the map band ends up with. */
    grid-auto-columns: calc((100% - 2 * var(--sp-2)) / 2.5);
    align-content: stretch;
  }
  .gallery.carousel .cards::-webkit-scrollbar {
    height: 6px;
  }
  .gallery.carousel .cards::-webkit-scrollbar-track {
    background: transparent;
  }
  .gallery.carousel .cards::-webkit-scrollbar-thumb {
    border-radius: var(--radius-pill);
    background: var(--line);
  }
  .gallery.carousel .cards::-webkit-scrollbar-thumb:hover {
    background: var(--faint);
  }
  .gallery.carousel .slot,
  .gallery.carousel .tcard {
    min-height: 0;
    height: 100%;
  }
  /* One tall tile: the preview takes the slack and the name sits under it,
     rather than a short picture floating at the top of an empty card. */
  .gallery.carousel .preview {
    flex: 1 1 auto;
    height: auto;
    min-height: 0;
  }
  /* The footer note is a page-level aside; in a scrolling strip it is noise. */
  .gallery.carousel > .hint {
    display: none;
  }

  /*
   * One option = one tile, and the preview fills it. The name sits under the
   * picture and everything else — shape, slot count, whether applying will
   * re-dimension the grid — is in the tooltip, because at this size a caption
   * competes with the thing it is captioning.
   */
  .slot {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .slot > .tcard {
    flex: 1 1 auto;
    min-width: 0;
  }

  .tcard {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--sp-1);
    padding: var(--sp-2);
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: inherit;
    font: inherit;
    cursor: pointer;
    min-height: 0;
    text-align: center;
    transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  .tcard:hover {
    border-color: var(--accent-line);
    background: var(--surface);
  }
  .tcard:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .tcard.active {
    border-color: var(--accent);
  }
  .tcard .tname {
    font-size: var(--fs-xs);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tcard.active .tname {
    color: var(--text);
  }
  .regrid {
    color: var(--warn);
  }

  /* Only for templates you made, and only when you are on the card. */
  .tdel {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--faint);
    font: inherit;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .slot:hover .tdel,
  .tdel:hover,
  .tdel:focus-visible {
    opacity: 1;
  }
  .tdel:hover,
  .tdel.armed {
    color: var(--bad);
    background: var(--surface-2);
  }

  .tcard:hover {
    border-color: var(--accent-line);
  }
  .tcard.active {
    border-color: var(--accent);
  }

  .preview {
    width: 100%;
    height: 56px;
    display: block;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .preview rect {
    fill: var(--accent-soft);
    stroke: var(--accent);
    stroke-width: 0.6%;
    vector-effect: non-scaling-stroke;
  }

  .tname {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }


</style>
