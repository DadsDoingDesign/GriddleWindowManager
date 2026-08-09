<script lang="ts">
  // Per-monitor transparent drag overlay (plan Task 15, spec §4.3 /overlay).
  //
  // The native window covers the monitor's *full* bounds exactly, so an SVG
  // with viewBox `0 0 monWidth monHeight` (physical px) stretched to
  // 100vw×100vh maps one viewBox unit onto one physical pixel — DPI scaling
  // is handled entirely by the browser and every stroke width below is in
  // physical pixels.
  //
  // Three layers for the grid in `?gridId=`:
  //   1. faint grid lines over the work area (1px, 12% accent opacity)
  //   2. the preview footprint (25% accent fill + 2px border; slot-to-slot
  //      moves glide over 120 ms)
  //   3. ghost outlines for displaced neighbors, each mounting at its `from`
  //      cell and easing out to its `to` cell
  // The whole stage fades in/out over 120 ms with the preview's `visible`
  // flag; the native window is hidden by the brain host only after the fade.
  //
  // Grid geometry arrives via the broadcast `state-snapshot` (requested once
  // with `overlay-ready`) and `list_monitors`; cell rects reuse the brain's
  // own `cellRect` so overlay pixels always agree with committed layouts.
  import { onDestroy, onMount } from 'svelte';
  import {
    cellRect,
    type GhostMove,
    type MonitorInfo,
    type PreviewState,
    type Slot,
    type StateSnapshot,
  } from '@griddle-wm/brain';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import {
    emitOverlayReady,
    listMonitors,
    onMonitorsChanged,
    onPreviewState,
    onStateSnapshot,
  } from '../../lib/ipc';

  interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** Breathing room (physical px) so footprints/ghosts read as windows, not cells. */
  const FOOTPRINT_INSET = 3;
  const GHOST_INSET = 5;

  const gridId = new URLSearchParams(window.location.search).get('gridId') ?? '';

  let monitors: MonitorInfo[] = $state([]);
  let dims: { cols: number; rows: number } | null = $state(null);
  let monitorIds: string[] = $state([]);
  let visible = $state(false);
  let footprint: Slot | null = $state(null);
  /** hwnd -> currently displayed ghost rect (reassigned to trigger updates). */
  let ghostRects: ReadonlyMap<string, Rect> = $state(new Map());

  /** The monitor this overlay window covers. */
  const mon = $derived(monitors.find((m) => monitorIds.includes(m.id)) ?? null);

  /** Absolute virtual-desktop rect -> overlay-window-local rect. */
  function toLocal(m: MonitorInfo, r: Rect): Rect {
    return { x: r.x - m.x, y: r.y - m.y, width: r.width, height: r.height };
  }

  function slotRect(slot: Slot): Rect | null {
    if (!mon || !dims) return null;
    return toLocal(mon, cellRect(mon, dims, slot));
  }

  function inset(r: Rect, by: number): Rect {
    // Never invert tiny cells.
    const dx = Math.min(by, r.width / 3);
    const dy = Math.min(by, r.height / 3);
    return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy };
  }

  const workRect = $derived(
    mon
      ? {
          x: mon.workX - mon.x,
          y: mon.workY - mon.y,
          width: mon.workWidth,
          height: mon.workHeight,
        }
      : null,
  );

  /** Interior column line positions (window-local x), matching cellRect edges. */
  const columnEdges = $derived.by(() => {
    if (!mon || !dims) return [];
    const xs: number[] = [];
    for (let col = 1; col < dims.cols; col++) {
      xs.push(cellRect(mon, dims, { col, row: 0, w: 1, h: 1 }).x - mon.x);
    }
    return xs;
  });

  /** Interior row line positions (window-local y). */
  const rowEdges = $derived.by(() => {
    if (!mon || !dims) return [];
    const ys: number[] = [];
    for (let row = 1; row < dims.rows; row++) {
      ys.push(cellRect(mon, dims, { col: 0, row, w: 1, h: 1 }).y - mon.y);
    }
    return ys;
  });

  const footprintRect = $derived.by(() => {
    if (!footprint) return null;
    const r = slotRect(footprint);
    return r ? inset(r, FOOTPRINT_INSET) : null;
  });

  const ghostEntries = $derived([...ghostRects.entries()]);

  function sameRect(a: Rect, b: Rect): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  /**
   * Reconcile displayed ghost rects with the preview's ghosts. New ghosts
   * mount at their `from` cell and are moved to `to` two frames later so the
   * CSS ease-out transition animates the from→to glide; known ghosts retarget
   * directly (the transition picks up from wherever they currently are).
   */
  function syncGhosts(ghosts: GhostMove[]) {
    const next = new Map<string, Rect>();
    const arriving: Array<[string, Rect]> = [];
    for (const g of ghosts) {
      const toR = slotRect(g.to);
      if (!toR) continue;
      const to = inset(toR, GHOST_INSET);
      const current = ghostRects.get(g.hwnd);
      if (current === undefined) {
        const fromR = slotRect(g.from);
        next.set(g.hwnd, fromR ? inset(fromR, GHOST_INSET) : to);
        arriving.push([g.hwnd, to]);
      } else {
        next.set(g.hwnd, to);
      }
    }
    ghostRects = next;
    if (arriving.length > 0) {
      // Double rAF: let the browser paint the `from` position first, then
      // flip to `to` so the transition runs instead of snapping.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const settled = new Map(ghostRects);
          let changed = false;
          for (const [hwnd, to] of arriving) {
            const cur = settled.get(hwnd);
            if (cur !== undefined && !sameRect(cur, to)) {
              settled.set(hwnd, to);
              changed = true;
            }
          }
          if (changed) ghostRects = settled;
        }),
      );
    }
  }

  function handlePreview(p: PreviewState) {
    if (p.gridId !== gridId) return; // the brain hides us explicitly
    if (!p.visible) {
      // Keep the last footprint/ghosts on screen while the stage fades out.
      visible = false;
      return;
    }
    if (!visible) ghostRects = new Map(); // fresh drag: forget stale ghosts
    visible = true;
    footprint = p.footprint;
    syncGhosts(p.ghosts);
  }

  function handleSnapshot(s: StateSnapshot) {
    const grid = s.grids.find((g) => g.id === gridId);
    dims = grid ? { cols: grid.cols, rows: grid.rows } : null;
    monitorIds = grid ? grid.monitorIds : [];
  }

  let unlisteners: UnlistenFn[] = [];

  onMount(() => {
    let cancelled = false;
    (async () => {
      const registered = await Promise.all([
        onPreviewState(handlePreview),
        onStateSnapshot(handleSnapshot),
        onMonitorsChanged((mons) => (monitors = mons)),
      ]);
      if (cancelled) {
        for (const u of registered) u();
        return;
      }
      unlisteners = registered;
      monitors = await listMonitors();
      // Ask the brain to re-broadcast its snapshot now that we can hear it.
      await emitOverlayReady();
    })().catch((e) => console.error('overlay init failed:', e));
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    for (const u of unlisteners) u();
    unlisteners = [];
  });
</script>

{#if mon && dims && workRect}
  <svg
    class="stage"
    class:visible
    viewBox="0 0 {mon.width} {mon.height}"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <!-- 1. faint grid: work-area frame + interior cell lines -->
    <g class="grid-lines">
      <rect
        class="work-border"
        x={workRect.x}
        y={workRect.y}
        width={workRect.width}
        height={workRect.height}
      />
      {#each columnEdges as x (x)}
        <line x1={x} y1={workRect.y} x2={x} y2={workRect.y + workRect.height} />
      {/each}
      {#each rowEdges as y (y)}
        <line x1={workRect.x} y1={y} x2={workRect.x + workRect.width} y2={y} />
      {/each}
    </g>

    <!-- 3. neighbor reflow ghosts (under the footprint) -->
    {#each ghostEntries as [hwnd, r] (hwnd)}
      <rect
        class="ghost"
        x={r.x}
        y={r.y}
        width={r.width}
        height={r.height}
        rx="6"
      />
    {/each}

    <!-- 2. preview footprint -->
    {#if footprintRect}
      <rect
        class="footprint"
        x={footprintRect.x}
        y={footprintRect.y}
        width={footprintRect.width}
        height={footprintRect.height}
        rx="8"
      />
    {/if}
  </svg>
{/if}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background: transparent;
    overflow: hidden;
  }

  .stage {
    /* Accent matches the app's brand purple; a hint brighter so 12% lines
       stay legible over both light and dark desktop content. */
    --ov-accent: #b44dff;
    --ease-out: cubic-bezier(0.22, 0.61, 0.36, 1);

    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    display: block;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }

  .stage.visible {
    opacity: 1;
  }

  /* 1px hairlines at 12% — present, never loud. */
  .grid-lines line {
    stroke: var(--ov-accent);
    stroke-opacity: 0.12;
    stroke-width: 1;
  }

  .work-border {
    fill: none;
    stroke: var(--ov-accent);
    stroke-opacity: 0.18;
    stroke-width: 1;
  }

  /* Where the window will land: quarter-strength fill, crisp 2px border,
     and a soft glow so it reads over any wallpaper. Slot changes glide. */
  .footprint {
    fill: var(--ov-accent);
    fill-opacity: 0.25;
    stroke: var(--ov-accent);
    stroke-opacity: 0.9;
    stroke-width: 2;
    filter: drop-shadow(0 0 6px rgba(180, 77, 255, 0.35));
    transition:
      x 120ms var(--ease-out),
      y 120ms var(--ease-out),
      width 120ms var(--ease-out),
      height 120ms var(--ease-out);
  }

  /* Displaced neighbors: dashed outlines easing from their current cell to
     where the reflow would put them. */
  .ghost {
    fill: var(--ov-accent);
    fill-opacity: 0.06;
    stroke: var(--ov-accent);
    stroke-opacity: 0.5;
    stroke-width: 1.5;
    stroke-dasharray: 7 5;
    transition:
      x 180ms var(--ease-out),
      y 180ms var(--ease-out),
      width 180ms var(--ease-out),
      height 180ms var(--ease-out);
  }
</style>
