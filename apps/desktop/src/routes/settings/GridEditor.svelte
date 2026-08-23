<script lang="ts">
  // Live grid editor (plan Task 13): a <GriddleGrid> mirroring one managed
  // grid. Tiles come from the brain's `state-snapshot`; a drop (or resize)
  // in the editor emits `settings-move`, the brain runs moveTileFromEditor,
  // and the real window snaps on screen. The parent recreates this component
  // (keyed) whenever gridId/cols/rows/mode change, so the Griddle instance
  // itself is created exactly once per configuration.
  import { onDestroy, tick } from 'svelte';
  import { createGriddle, GriddleGrid } from '@griddle/svelte';
  import type { Tile } from '@griddle/core';
  import {
    effectiveSpacing,
    type AppRule,
    type MonitorInfo,
    type PlacementMode,
    type Slot,
    type TileSnapshot,
  } from '@griddle-wm/brain';
  import {
    emitSettingsMove,
    emitSettingsRemoveAppRule,
    emitSettingsSetAppRule,
  } from '../../lib/ipc';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';

  interface Props {
    gridId: string;
    cols: number;
    rows: number;
    mode: PlacementMode;
    monitor: MonitorInfo;
    tiles: TileSnapshot[];
    /** Measured size of the band this editor fills. */
    width?: number;
    height?: number;
    /** Grid spacing (spec v0.2 §1), physical px — scaled into editor space. */
    gap: number;
    padding: number;
    /** Live per-app rules (spec v0.2 §2) — drive the tile context menu. */
    appRules: AppRule[];
  }
  const {
    gridId,
    cols,
    rows,
    mode,
    monitor,
    tiles,
    gap,
    padding,
    appRules,
    width = 0,
    height = 0,
  }: Props = $props();

  // Editor mirrors the monitor's aspect ratio at a fixed width. The grid's
  // gap/padding pass through the same effectiveSpacing (incl. the coercion
  // that keeps units >= 16px) and are then scaled by the editor's miniature
  // factor, so what the editor shows is exactly what the desktop gets
  // (spec v0.2 §1 editor parity). Reading props once at init is on purpose:
  // the parent keys this component on gridId/cols/rows/mode/gap/padding, so
  // any config change remounts it.
  // The map spans its band edge to edge. The width is measured by the parent
  // and passed in, because the pop-out is resizable *and* can be tiled into a
  // grid cell of any width — a constant left gutters the moment either
  // happened. The parent also keys this component on that width, so the
  // read-props-once-at-init contract (and with it editor/desktop parity)
  // stays exactly as it was: a different width is a different instance.
  // Fit the band without distorting the display it maps. The band gives us a
  // box; the monitor gives us a shape. Take whichever of the two constraints
  // binds first, so a wide band letterboxes vertically and a tall one
  // letterboxes horizontally, and the aspect ratio is never the thing that
  // gives — a minimap whose proportions are a function of the window is not a
  // map of anything.
  const EDITOR_W = (() => {
    const w = width > 0 ? width : 460;
    const h = height > 0 ? height : 0;
    const aspect = monitor.workWidth / Math.max(1, monitor.workHeight);
    return h > 0 ? Math.max(80, Math.min(w, Math.floor(h * aspect))) : w;
  })();
  /* svelte-ignore state_referenced_locally */
  const layout = (() => {
    const eff = effectiveSpacing(monitor, { cols, rows, gap, padding });
    const scale = EDITOR_W / monitor.workWidth;
    const innerW = eff.width * scale;
    const innerH = eff.height * scale;
    // Griddle takes one gap for both axes; the x gap wins (the axes only
    // ever differ when the coercion clamps one of them).
    const gapPx = eff.gapX * scale;
    return {
      padX: (eff.x - monitor.workX) * scale,
      padY: (eff.y - monitor.workY) * scale,
      height: Math.round(innerH),
      unitWidth: (innerW - cols * gapPx) / cols,
      unitHeight: (innerH - rows * gapPx) / rows,
      gap: gapPx,
    };
  })();

  /* svelte-ignore state_referenced_locally */
  const api = createGriddle({
    config: {
      cols,
      rows,
      unitWidth: layout.unitWidth,
      unitHeight: layout.unitHeight,
      gap: layout.gap,
      gravity: 'none',
      enablePositioning: true,
      pinUnits: 'cells',
      tileRadius: 6,
      // No reposition animation. Two reasons, and the second is a bug.
      //
      // This editor is a *map* of what the desktop is doing right now, and
      // the real windows snap. A 320ms slide (the library default) means the
      // map disagrees with the desktop for a third of a second after every
      // drag, which reads as "the tiles are offset" — that is exactly how it
      // was reported.
      //
      // And the slide is drawn from the wrong place for out-of-flow tiles:
      // GriddleGrid's FLIP pass takes each tile's origin as
      // `col * colSize + halfGap`, but an `absolute` tile is positioned from
      // `pinned` instead. When those two disagree — which they do here, since
      // overlapping snapshot tiles are mirrored as absolute — the tile
      // animates in from a bogus offset. Turning the animation off sidesteps
      // it; the library note is in docs/library-feedback.md.
      animation: { repositionDurationMs: 0 },
      // `scroll` is deliberately left at its default (contained). It reads
      // like a scrollbar preference and is not: `contained = cfg.scroll !==
      // 'none'` also decides whether the grid gets an explicit height and
      // clips, and the tile layout is computed against that box. Setting it
      // to 'none' to suppress two stray scrollbars flipped the grid to
      // `height: auto; overflow: visible` and tiles started rendering off
      // their cell boundaries. The scrollbars were a 1-2px overflow and
      // `.editor` already clips, so they are hidden in CSS below instead —
      // presentation stays presentation, geometry stays geometry.
    },
  });
  onDestroy(() => {
    stopWatchingSnaps();
    api.destroy();
  });

  const infoByHwnd = $derived(new Map(tiles.map((t) => [t.hwnd, t])));

  function sameSlot(a: Slot, b: Slot): boolean {
    return a.col === b.col && a.row === b.row && a.w === b.w && a.h === b.h;
  }

  /** A tile's slot in grid cells (pinned coords for absolute tiles). */
  function slotOf(t: Tile): Slot {
    if (t.position === 'absolute' && t.pinned) {
      return { col: t.pinned.x, row: t.pinned.y, w: t.w, h: t.h };
    }
    return { col: t.col, row: t.row, w: t.w, h: t.h };
  }

  /** Shrink/shift a slot fully inside the grid (pin drags are unclamped). */
  function clampSlot(s: Slot): Slot {
    const w = Math.min(Math.max(Math.round(s.w), 1), cols);
    const h = Math.min(Math.max(Math.round(s.h), 1), rows);
    return {
      col: Math.min(Math.max(Math.round(s.col), 0), cols - w),
      row: Math.min(Math.max(Math.round(s.row), 0), rows - h),
      w,
      h,
    };
  }

  /** Do two slots share any cell? */
  function slotsOverlap(a: Slot, b: Slot): boolean {
    return (
      a.col < b.col + b.w &&
      b.col < a.col + a.w &&
      a.row < b.row + b.h &&
      b.row < a.row + a.h
    );
  }

  /**
   * Which windows the snapshot itself says are stacked.
   *
   * Computed from the whole list rather than from whatever happens to be in
   * the grid at the moment each tile is added. The old test was
   * `api.grid.tilesIn(rect).length > 0` during a partial rebuild, which is
   * order-dependent: a window could be pinned as absolute purely because
   * reconcile had not yet moved the tile that was sitting in its cell. Pinned
   * tiles are out of flow, so the engine will not displace them and a drop
   * onto one is refused — that is how an ordinary window came to reject
   * drags, and a refused drop is what left the map showing two tiles stacked
   * in one cell.
   */
  function stackedInSnapshot(list: { hwnd: string; slot: Slot }[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (slotsOverlap(list[i]!.slot, list[j]!.slot)) out.add(list[j]!.hwnd);
      }
    }
    return out;
  }

  function addTileAt(hwnd: string, slot: Slot, absolute: boolean): void {
    const rect = { col: slot.col, row: slot.row, w: slot.w, h: slot.h };
    // Stack grids overlap by design; in push/reflow grids an overlapping
    // snapshot tile is one the brain keeps absolute (non-resizable window),
    // so mirror it as absolute here to keep the in-flow engine consistent.
    if (absolute) {
      api.addTile({
        id: hwnd,
        ...rect,
        position: 'absolute',
        pinned: { x: rect.col, y: rect.row },
        resizable: false, // no out-of-flow resize API; drag-to-move only
        minW: 1,
        minH: 1,
      });
    } else {
      api.addTile({ id: hwnd, ...rect, minW: 1, minH: 1 });
    }
  }

  /** Make the editor grid match the snapshot exactly. */
  function reconcile(list: TileSnapshot[]): void {
    const want = new Map(list.map((t) => [t.hwnd, t.slot]));
    const stacked = stackedInSnapshot(list);
    for (const t of [...api.grid.tiles]) {
      if (!want.has(t.id)) api.removeTile(t.id);
    }
    for (const s of list) {
      const cur = api.grid.getTile(s.hwnd);
      if (cur && sameSlot(slotOf(cur), s.slot)) continue;
      if (cur) api.removeTile(s.hwnd);
      addTileAt(s.hwnd, s.slot, mode === 'stack' || stacked.has(s.hwnd));
    }
  }

  // Snapshot updates arriving mid-gesture are deferred so they don't yank
  // the tile out from under the cursor.
  let editorEl: HTMLDivElement | undefined = $state();

  /** How long the resize snap flash lasts. */
  const SNAP_MS = 190;

  /**
   * Live outline of where a resize will land.
   *
   * The grid quantises a resize to whole cells with `Math.round(dx / colSize)`,
   * and on this map a cell is ~119px wide — so nothing moves until the pointer
   * has travelled 60px, a sixth of the whole map, and then it jumps a full
   * column. With no other feedback that reads as "the preview never shrinks,
   * it just snaps when I let go", which is exactly how it was reported.
   *
   * The library draws a drop indicator for drags but not for resizes, so this
   * is ours: it appears the moment the grip is grabbed, showing the current
   * footprint, and moves to each new target as the threshold is crossed. The
   * dead zone is unchanged — it is inherent to snapping — but it stops being
   * invisible, which was the actual complaint.
   */
  let resizeGhost = $state<Slot | null>(null);
  /** Pointer position and footprint at the moment the grip was grabbed. */
  let grip: { x: number; y: number; slot: Slot } | null = null;
  let snapObs: ResizeObserver | null = null;
  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  let interacting = false;
  let pending: TileSnapshot[] | null = null;

  $effect(() => {
    const list = tiles;
    if (interacting) {
      pending = list;
    } else {
      reconcile(list);
    }
  });

  function commitTile(hwnd: string): void {
    const t = api.grid.getTile(hwnd);
    if (!t) return;
    void emitSettingsMove({ gridId, hwnd, slot: clampSlot(slotOf(t)) });
  }

  function beginInteraction(): void {
    interacting = true;
  }

  /**
   * Flash a tile every time a resize snaps to a different number of cells.
   *
   * The preview is already quantised — the tile jumps a whole cell at a time
   * — but with nothing marking the jump it is hard to tell whether the drag
   * is yet big enough for the next column, which is the one thing you want to
   * know while resizing. The flash is that confirmation, and it leans one way
   * for growing and the other for shrinking.
   *
   * The grid only dispatches `resizeStart`/`resizeEnd`, never a per-step
   * event, so the snap is read off the tile's own box instead: it changes size
   * only when the preview crosses a threshold, which makes every change a
   * snap by definition and needs nothing from the library.
   */
  function watchSnaps(tileId: string): void {
    stopWatchingSnaps();
    if (!editorEl) return;
    const wrapper = editorEl.querySelector<HTMLElement>(
      `[data-griddle-tile="${CSS.escape(tileId)}"]`,
    );
    const node = wrapper?.querySelector<HTMLElement>('.wtile') ?? wrapper;
    if (!wrapper || !node) return;
    let prev: { w: number; h: number } | null = null;
    snapObs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const next = { w: Math.round(r.width), h: Math.round(r.height) };
      // The first callback is the initial size, not a snap.
      if (prev && (next.w !== prev.w || next.h !== prev.h)) {
        flashSnap(node, next.w * next.h > prev.w * prev.h);
      }
      prev = next;
    });
    snapObs.observe(wrapper);
  }

  function stopWatchingSnaps(): void {
    snapObs?.disconnect();
    snapObs = null;
    if (snapTimer !== null) {
      clearTimeout(snapTimer);
      snapTimer = null;
    }
  }

  function flashSnap(node: HTMLElement, grew: boolean): void {
    node.classList.remove('snap-grow', 'snap-shrink');
    void node.offsetWidth; // restart the animation when snaps come quickly
    node.classList.add(grew ? 'snap-grow' : 'snap-shrink');
    if (snapTimer !== null) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      node.classList.remove('snap-grow', 'snap-shrink');
      snapTimer = null;
    }, SNAP_MS);
  }

  /**
   * Record where the grip was grabbed. The `resizeStart` event does not carry
   * a pointer position, so it is taken here, in the capture phase, before the
   * grid's own handler runs.
   */
  function onEditorPointerDown(e: PointerEvent): void {
    const el = e.target as HTMLElement | null;
    if (!el?.closest('[data-griddle-handle]')) return;
    const id = el.closest('[data-griddle-tile]')?.getAttribute('data-griddle-tile');
    const tile = id ? api.grid.getTile(id) : null;
    if (!tile) return;
    grip = { x: e.clientX, y: e.clientY, slot: slotOf(tile) };
    resizeGhost = grip.slot;
  }

  function onResizePointerMove(e: PointerEvent): void {
    if (!grip) return;
    // Same quantisation the grid uses, so the outline never disagrees with
    // where the tile actually lands.
    const colSize = layout.unitWidth + layout.gap;
    const rowSize = layout.unitHeight + layout.gap;
    const stepsX = Math.round((e.clientX - grip.x) / colSize);
    const stepsY = Math.round((e.clientY - grip.y) / rowSize);
    // Only the south-east grip is enabled, so the origin never moves.
    const w = Math.min(Math.max(1, grip.slot.w + stepsX), cols - grip.slot.col);
    const h = Math.min(Math.max(1, grip.slot.h + stepsY), rows - grip.slot.row);
    const next = { col: grip.slot.col, row: grip.slot.row, w, h };
    if (!resizeGhost || !sameSlot(resizeGhost, next)) resizeGhost = next;
  }

  function clearGrip(): void {
    grip = null;
    resizeGhost = null;
  }

  function beginResize(e: CustomEvent<{ tileId: string }>): void {
    interacting = true;
    watchSnaps(e.detail.tileId);
  }

  function endResize(e: CustomEvent<{ tileId: string; committed: boolean }>): void {
    stopWatchingSnaps();
    clearGrip();
    endInteraction(e);
  }

  /**
   * Drop the pixel-space inline styles the grid layers on tiles during a
   * gesture.
   *
   * Tiles are positioned by `left`/`top` in whole cells, and that is always
   * correct. On top of it the library writes gesture offsets — `transform`
   * for the live drag, `translate` for FLIP — and only ever clears them on
   * the *next* reposition. After a drop there is no next reposition until the
   * brain's answering snapshot lands, so for the ~half second of that round
   * trip a tile keeps a sub-cell offset and the map disagrees with the
   * desktop. Measured at +71px after one drag and +46px after another: it
   * tracks the gesture, not the grid.
   *
   * Clearing them is safe because the correct position is already underneath:
   * `transform` is Svelte-bound and re-applied on the next render (to `''`
   * once the drag is over), and `translate` is only ever written by FLIP.
   */
  async function clearGestureOffsets(): Promise<void> {
    await tick(); // let the grid's own post-gesture render land first
    if (!editorEl) return;
    for (const el of editorEl.querySelectorAll<HTMLElement>('[data-griddle-tile]')) {
      el.style.translate = '';
      el.style.transform = '';
    }
  }

  /**
   * Force the grid's adapter to re-read its own tiles.
   *
   * `GriddleGrid` keeps a local `tilesAll` copy for rendering and refreshes it
   * from the engine during a drag — its pointermove handler does so
   * explicitly, with a comment noting that internal repacks emit no change
   * event. Its pointerup handler does not. So once a gesture ends the view can
   * be a repack behind the engine, which is what put two tiles in one square
   * with the neighbouring cell empty, for as long as it took the next snapshot
   * to arrive (measured at well over a second).
   *
   * Rebuilding through `api` emits the change events the adapter does listen
   * to. The arrangement is read back from the engine first, so this re-renders
   * what is already true rather than moving anything.
   */
  function resyncFromEngine(): void {
    const snap = api.grid.tiles.map((t) => ({ hwnd: t.id, slot: slotOf(t) }));
    const stacked = stackedInSnapshot(snap);
    for (const t of [...api.grid.tiles]) api.removeTile(t.id);
    for (const s of snap) {
      addTileAt(s.hwnd, s.slot, mode === 'stack' || stacked.has(s.hwnd));
    }
  }

  function endInteraction(e: CustomEvent<{ tileId: string; committed: boolean }>): void {
    interacting = false;
    if (e.detail.committed) {
      // The brain's answering snapshot is the source of truth; any snapshot
      // deferred during the gesture is stale now.
      pending = null;
      commitTile(e.detail.tileId);
      // The engine holds the committed arrangement; the adapter may not.
      resyncFromEngine();
    } else {
      // The drop was refused. `DragController.end()` calls
      // `grid.restoreTiles()`, which deliberately emits no change event, and
      // GriddleGrid does not resync its own tile list afterwards the way its
      // pointermove handler does. So what stays on screen is the mid-drag
      // arrangement — the displaced neighbour still displaced and the dragged
      // tile back in its pickup cell, the two overlapping in one square —
      // until the next snapshot happens along. Re-render from the last
      // authoritative one now instead of waiting.
      reconcile(pending ?? tiles);
      pending = null;
    }
    void clearGestureOffsets();
  }

  // ── tile context menu: per-app defaults (spec v0.2 §2) ───────────────────
  // Right-click (or Shift+F10 / the menu key on a focused tile) offers to
  // save the tile's current slot as the default spot for its program — on
  // this grid or on every grid — and to remove a default that exists.

  let menu: { x: number; y: number; hwnd: string } | null = $state(null);

  const menuTile = $derived.by(() => {
    const m = menu;
    return m ? infoByHwnd.get(m.hwnd) : undefined;
  });

  /**
   * Menu entries (critique round). Every label is short and fixed-length,
   * and the differentiating word ("this grid" / "all grids") is never at the
   * end of a variable-length string: the exe lives in the menu's header row
   * instead. With the menu's nowrap+ellipsis at 340px, a long exe
   * (msedgewebview2.exe, ApplicationFrameHost.exe) used to truncate exactly
   * the part that told the four entries apart.
   *
   * Save vs Update: the menu already knows whether a rule exists for a scope
   * (it decides the Remove entries on it), so the save entry says which it
   * is instead of calling an overwrite "Save".
   */
  const menuItems = $derived.by((): MenuItem[] => {
    const t = menuTile;
    if (!t || t.exe === '') return [];
    const { exe, slot } = t;
    const hasGridRule = appRules.some((r) => r.exe === exe && r.gridId === gridId);
    const hasAnyRule = appRules.some((r) => r.exe === exe && r.gridId === null);
    const items: MenuItem[] = [
      {
        label: hasGridRule ? 'Update for this grid' : 'Save for this grid',
        action: () =>
          void emitSettingsSetAppRule({ rule: { exe, gridId, slot: { ...slot } } }),
      },
      {
        label: hasAnyRule ? 'Update for all grids' : 'Save for all grids',
        action: () =>
          void emitSettingsSetAppRule({ rule: { exe, gridId: null, slot: { ...slot } } }),
      },
    ];
    // Remove entries appear only for rules that exist, one per scope — the
    // menu never pretends there is something to remove.
    if (hasGridRule) {
      items.push({
        label: 'Remove for this grid',
        danger: true,
        action: () => void emitSettingsRemoveAppRule({ exe, gridId }),
      });
    }
    if (hasAnyRule) {
      items.push({
        label: 'Remove for all grids',
        danger: true,
        action: () => void emitSettingsRemoveAppRule({ exe, gridId: null }),
      });
    }
    return items;
  });

  function openMenuAt(x: number, y: number, hwnd: string): void {
    // A tile without a known exe has nothing to save a rule for.
    const info = infoByHwnd.get(hwnd);
    if (!info || info.exe === '') return;
    menu = { x, y, hwnd };
  }

  function onTileContextMenu(e: MouseEvent, hwnd: string): void {
    e.preventDefault();
    e.stopPropagation();
    openMenuAt(e.clientX, e.clientY, hwnd);
  }

  /**
   * GriddleGrid starts a drag on *any* tile pointerdown (it never checks
   * e.button — see docs/library-feedback.md), so the secondary button must
   * be stopped before it bubbles to the library's handler.
   */
  function onTilePointerDown(e: PointerEvent): void {
    if (e.button !== 0) e.stopPropagation();
  }

  /** Keyboard path to the same menu: Shift+F10 or the dedicated menu key. */
  function onTileKeydown(e: KeyboardEvent, hwnd: string): void {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(r.left + 12, r.bottom - 6, hwnd);
    }
  }
</script>

<svelte:window onpointermove={onResizePointerMove} onpointerup={clearGrip} onpointercancel={clearGrip} />

<div
  class="editor"
  bind:this={editorEl}
  style:width="{EDITOR_W}px"
  onpointerdowncapture={onEditorPointerDown}
>
  {#if resizeGhost}
    <!-- Where the resize will land. Purely presentational and pointer-inert,
         so it can never intercept the gesture that is drawing it. -->
    <div
      class="resize-ghost"
      style:left="{layout.padX + resizeGhost.col * (layout.unitWidth + layout.gap) + layout.gap / 2}px"
      style:top="{layout.padY + resizeGhost.row * (layout.unitHeight + layout.gap) + layout.gap / 2}px"
      style:width="{resizeGhost.w * layout.unitWidth + (resizeGhost.w - 1) * layout.gap}px"
      style:height="{resizeGhost.h * layout.unitHeight + (resizeGhost.h - 1) * layout.gap}px"
    ></div>
  {/if}
  <!-- Scaled padding inset: the well showing through here is the same strip
       of desktop the real padding leaves free. -->
  <div class="pad" style:padding="{layout.padY}px {layout.padX}px">
    <GriddleGrid
      {api}
      height={layout.height}
      showGrid={true}
      on:dragStart={beginInteraction}
      on:dragEnd={endInteraction}
      on:resizeStart={beginResize}
      on:resizeEnd={endResize}
    >
      <div
        slot="tile"
        let:tile
        class="wtile"
        title={infoByHwnd.get(tile.id)?.title}
        role="button"
        tabindex="0"
        aria-haspopup="menu"
        aria-label={`${infoByHwnd.get(tile.id)?.title || `Window ${tile.id}`} — Shift+F10 for app-default options`}
        oncontextmenu={(e) => onTileContextMenu(e, tile.id)}
        onpointerdown={onTilePointerDown}
        onkeydown={(e) => onTileKeydown(e, tile.id)}
      >
        <span class="wtitle">{infoByHwnd.get(tile.id)?.title || `Window ${tile.id}`}</span>
        <span class="wexe">{infoByHwnd.get(tile.id)?.exe ?? ''}</span>
      </div>
    </GriddleGrid>
  </div>
</div>

{#if menu && menuItems.length > 0}
  <ContextMenu
    x={menu.x}
    y={menu.y}
    label={`App default for ${menuTile?.exe ?? ''}`}
    header={`${menuTile?.exe ?? ''} — default spot`}
    items={menuItems}
    onclose={() => (menu = null)}
  />
{/if}

<style>
  .resize-ghost {
    position: absolute;
    z-index: 5;
    pointer-events: none;
    border: 2px dashed var(--accent);
    border-radius: 7px;
    background: rgba(139, 124, 246, 0.1);
  }

  .editor {
    position: relative;
    /* Flush in its band: the band's own rule separates it from the row above,
       so a border and a radius here would draw a second, inset frame. */
    border: 0;
    border-radius: 0;
    background: var(--surface-2);
    overflow: hidden;
    /* The monitor decides this box's shape, so it must not absorb slack from
       the flex column that holds it. */
    flex: 0 0 auto;
  }

  /*
   * The map is a fixed viewport onto the grid, so its scroll box must not
   * scroll. `gridContentSize` deliberately pads the canvas two cells past the
   * furthest tile (`t.row + t.h + 2`) as growth headroom, which on a
   * fixed-size map is just empty space below the real grid — and hiding the
   * scrollbars left it reachable by wheel, so the minimap could be scrolled
   * down past the bottom of the display it maps.
   *
   * `.griddle-scroll` is sized to the grid's own height, so clipping it shows
   * exactly the grid and nothing else. `!important` because the adapter sets
   * `overflow` inline from its `contained` flag.
   */
  .editor :global(.griddle-scroll) {
    overflow: hidden !important;
  }
  .editor :global(*) {
    scrollbar-width: none;
  }
  .editor :global(*::-webkit-scrollbar) {
    width: 0;
    height: 0;
    display: none;
  }

  /* Resize snap feedback (see watchSnaps). The classes are applied from JS
     and the keyframes referenced from a :global rule, so both have to escape
     component scoping or the compiler prunes them as unused. */
  .editor :global(.snap-grow) {
    animation: griddle-snap-grow 190ms ease-out;
  }
  .editor :global(.snap-shrink) {
    animation: griddle-snap-shrink 190ms ease-out;
  }

  /* Growing: a crisp edge lands on the new boundary and fades — "it fits". */
  @keyframes -global-griddle-snap-grow {
    0% {
      box-shadow: inset 0 0 0 2px var(--accent);
      background: rgba(139, 124, 246, 0.34);
    }
    100% {
      box-shadow: inset 0 0 0 2px transparent;
      background: rgba(139, 124, 246, 0.14);
    }
  }

  /* Shrinking: a thick inner ring collapses inward — "it pulled in a cell". */
  @keyframes -global-griddle-snap-shrink {
    0% {
      box-shadow: inset 0 0 0 10px rgba(139, 124, 246, 0.3);
      background: rgba(139, 124, 246, 0.3);
    }
    100% {
      box-shadow: inset 0 0 0 0 transparent;
      background: rgba(139, 124, 246, 0.14);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .editor :global(.snap-grow),
    .editor :global(.snap-shrink) {
      animation: none;
    }
  }

  /* Dark-theme overrides for the GriddleGrid internals. */
  .editor :global(.grid-bg) {
    background-image:
      linear-gradient(to right, rgba(255, 255, 255, 0.05) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
  }
  .editor :global(.griddle-drop-indicator) {
    border: 2px dashed rgba(139, 124, 246, 0.65);
    background: rgba(139, 124, 246, 0.12);
  }
  /*
   * The library hangs its resize grip 6px *outside* the tile corner
   * (`bottom: -6px; right: -6px`) and shows it always. On a map this small
   * that drops a 12px square into the gap or straight onto the neighbouring
   * tile, and with one per tile it reads as stray overlay squares rather
   * than grips — reported as "another square in the bottom right that
   * doesn't exist". Tuck it inside its own tile, shrink it, and only show it
   * on hover or keyboard focus so a resting map is just the map.
   */
  .editor :global(.griddle-handle) {
    background: var(--accent);
    border-color: var(--surface-2);
    width: 10px;
    height: 10px;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .editor :global(.griddle-handle-se) {
    bottom: 3px;
    right: 3px;
  }
  .editor :global(.griddle-handle-sw) {
    bottom: 3px;
    left: 3px;
  }
  .editor :global(.griddle-handle-ne) {
    top: 3px;
    right: 3px;
  }
  .editor :global(.griddle-handle-nw) {
    top: 3px;
    left: 3px;
  }
  .editor :global(.griddle-tile:hover .griddle-handle),
  .editor :global(.griddle-tile:focus-within .griddle-handle) {
    opacity: 1;
  }
  /* Keep it visible for the whole gesture, even if the pointer leaves the
     tile it started on — which it does, because resizing moves the corner. */
  .editor :global(.griddle-tile.griddle-resizing .griddle-handle) {
    opacity: 1;
  }

  .wtile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .wtile {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 6px 10px;
    overflow: hidden;
    border-radius: var(--griddle-tile-radius, 6px);
    background: rgba(139, 124, 246, 0.14);
    border: 1px solid rgba(139, 124, 246, 0.42);
    color: var(--muted);
  }
  .wtitle {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wexe {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
