<script lang="ts">
  // Live grid editor (plan Task 13): a <GriddleGrid> mirroring one managed
  // grid. Tiles come from the brain's `state-snapshot`; a drop (or resize)
  // in the editor emits `settings-move`, the brain runs moveTileFromEditor,
  // and the real window snaps on screen. The parent recreates this component
  // (keyed) whenever gridId/cols/rows/mode change, so the Griddle instance
  // itself is created exactly once per configuration.
  import { onDestroy } from 'svelte';
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
    /** Grid spacing (spec v0.2 §1), physical px — scaled into editor space. */
    gap: number;
    padding: number;
    /** Live per-app rules (spec v0.2 §2) — drive the tile context menu. */
    appRules: AppRule[];
  }
  const { gridId, cols, rows, mode, monitor, tiles, gap, padding, appRules }: Props =
    $props();

  // Editor mirrors the monitor's aspect ratio at a fixed width. The grid's
  // gap/padding pass through the same effectiveSpacing (incl. the coercion
  // that keeps units >= 16px) and are then scaled by the editor's miniature
  // factor, so what the editor shows is exactly what the desktop gets
  // (spec v0.2 §1 editor parity). Reading props once at init is on purpose:
  // the parent keys this component on gridId/cols/rows/mode/gap/padding, so
  // any config change remounts it.
  // Sized for the settings pop-out, which is a narrow panel rather than a
  // page. 632 was the full-width page figure and made the map the tallest
  // thing in the window by a wide margin; 360 keeps it clearly readable as a
  // map of the display while leaving room for the controls stacked beneath.
  const EDITOR_W = 360;
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
  onDestroy(() => api.destroy());

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

  function addTileAt(hwnd: string, slot: Slot): void {
    const rect = { col: slot.col, row: slot.row, w: slot.w, h: slot.h };
    // Stack grids overlap by design; in push/reflow grids an overlapping
    // snapshot tile is one the brain keeps absolute (non-resizable window),
    // so mirror it as absolute here to keep the in-flow engine consistent.
    const absolute = mode === 'stack' || api.grid.tilesIn(rect).length > 0;
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
    for (const t of [...api.grid.tiles]) {
      if (!want.has(t.id)) api.removeTile(t.id);
    }
    for (const s of list) {
      const cur = api.grid.getTile(s.hwnd);
      if (cur && sameSlot(slotOf(cur), s.slot)) continue;
      if (cur) api.removeTile(s.hwnd);
      addTileAt(s.hwnd, s.slot);
    }
  }

  // Snapshot updates arriving mid-gesture are deferred so they don't yank
  // the tile out from under the cursor.
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

  function endInteraction(e: CustomEvent<{ tileId: string; committed: boolean }>): void {
    interacting = false;
    if (e.detail.committed) {
      // The brain's answering snapshot is the source of truth; any snapshot
      // deferred during the gesture is stale now.
      pending = null;
      commitTile(e.detail.tileId);
    } else if (pending) {
      reconcile(pending);
      pending = null;
    }
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

<div class="editor" style:width="{EDITOR_W}px">
  <!-- Scaled padding inset: the well showing through here is the same strip
       of desktop the real padding leaves free. -->
  <div class="pad" style:padding="{layout.padY}px {layout.padX}px">
    <GriddleGrid
      {api}
      height={layout.height}
      showGrid={true}
      on:dragStart={beginInteraction}
      on:dragEnd={endInteraction}
      on:resizeStart={beginInteraction}
      on:resizeEnd={endInteraction}
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
  .editor {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--well);
    overflow: hidden;
    /* The monitor decides this box's shape, so it must not absorb slack from
       the flex column that holds it. */
    flex: 0 0 auto;
  }

  /* The grid is a contained scroll box (see the `scroll` note in the config)
     and overflows its own height by a pixel or two, which drew scrollbars
     across the map. `.editor` already clips to the exact aspect-correct
     rect, so the bars have nothing to reveal — hide them without touching
     the layout mode that positions the tiles. */
  .editor :global(*) {
    scrollbar-width: none;
  }
  .editor :global(*::-webkit-scrollbar) {
    width: 0;
    height: 0;
    display: none;
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
  .editor :global(.griddle-handle) {
    background: var(--accent);
    border-color: var(--well);
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
    color: var(--text);
  }
  .wtitle {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wexe {
    font-size: 10px;
    font-family: var(--mono);
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
