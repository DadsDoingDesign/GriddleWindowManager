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
  import type { MonitorInfo, Slot, TileSnapshot } from '@griddle-wm/brain';
  import { emitSettingsMove } from '../../lib/ipc';

  interface Props {
    gridId: string;
    cols: number;
    rows: number;
    mode: 'collision' | 'overlay';
    monitor: MonitorInfo;
    tiles: TileSnapshot[];
  }
  const { gridId, cols, rows, mode, monitor, tiles }: Props = $props();

  // Editor mirrors the monitor's aspect ratio at a fixed width.
  const EDITOR_W = 632;
  const GAP = 4;
  // These read props once at init on purpose: the parent keys this component
  // on gridId/cols/rows/mode, so a config change remounts it.
  /* svelte-ignore state_referenced_locally */
  const editorH = Math.round((EDITOR_W * monitor.workHeight) / monitor.workWidth);
  /* svelte-ignore state_referenced_locally */
  const unitWidth = (EDITOR_W - cols * GAP) / cols;
  /* svelte-ignore state_referenced_locally */
  const unitHeight = (editorH - rows * GAP) / rows;

  // The parent keys this component on gridId/cols/rows/mode, so reading
  // those props once at init is correct — a config change remounts us.
  /* svelte-ignore state_referenced_locally */
  const api = createGriddle({
    config: {
      cols,
      rows,
      unitWidth,
      unitHeight,
      gap: GAP,
      gravity: 'none',
      enablePositioning: true,
      pinUnits: 'cells',
      tileRadius: 6,
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
    // Overlay grids overlap by design; in collision grids an overlapping
    // snapshot tile is one the brain keeps absolute (non-resizable window),
    // so mirror it as absolute here to keep the in-flow engine consistent.
    const absolute = mode === 'overlay' || api.grid.tilesIn(rect).length > 0;
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
</script>

<div class="editor" style:width="{EDITOR_W}px">
  <GriddleGrid
    {api}
    height={editorH}
    showGrid={true}
    on:dragStart={beginInteraction}
    on:dragEnd={endInteraction}
    on:resizeStart={beginInteraction}
    on:resizeEnd={endInteraction}
  >
    <div slot="tile" let:tile class="wtile" title={infoByHwnd.get(tile.id)?.title}>
      <span class="wtitle">{infoByHwnd.get(tile.id)?.title || `Window ${tile.id}`}</span>
      <span class="wexe">{infoByHwnd.get(tile.id)?.exe ?? ''}</span>
    </div>
  </GriddleGrid>
</div>

<style>
  .editor {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--well);
    overflow: hidden;
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
