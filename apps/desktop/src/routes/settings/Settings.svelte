<script lang="ts">
  // Settings window (plan Task 13): monitor cards with per-monitor grid
  // enable toggles and cols/rows steppers, plus the live GriddleGrid editor
  // bound to the brain's `state-snapshot`. All mutations go through
  // settings-* events to the brain page (contract §C2), which applies them
  // to real windows and persists the config.
  import { onDestroy, onMount } from 'svelte';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import type { GridSettings, MonitorInfo, StateSnapshot } from '@griddle-wm/brain';
  import {
    emitSettingsDisableGrid,
    emitSettingsEnableGrid,
    emitSettingsReady,
    emitSettingsSetDims,
    listMonitors,
    onMonitorsChanged,
    onStateSnapshot,
  } from '../../lib/ipc';
  import GridEditor from './GridEditor.svelte';

  const MAX_COLS = 32;
  const MAX_ROWS = 16;
  const DEFAULT_DIMS = { cols: 12, rows: 6 };

  let monitors: MonitorInfo[] = $state([]);
  let snapshot: StateSnapshot | null = $state(null);
  /** Stepper values for monitors whose grid is not currently enabled. */
  let draftDims: Record<string, { cols: number; rows: number }> = $state({});

  let unlisteners: UnlistenFn[] = [];
  onMount(async () => {
    unlisteners = await Promise.all([
      onStateSnapshot((s) => (snapshot = s)),
      onMonitorsChanged((m) => (monitors = m)),
    ]);
    monitors = await listMonitors();
    // Ask the brain to re-emit its latest snapshot for this fresh window.
    await emitSettingsReady();
  });
  onDestroy(() => {
    for (const u of unlisteners) u();
  });

  function gridFor(monitorId: string): GridSettings | undefined {
    return snapshot?.grids.find(
      (g) => g.monitorIds.length === 1 && g.monitorIds[0] === monitorId,
    );
  }

  function dimsFor(mon: MonitorInfo): { cols: number; rows: number } {
    const g = gridFor(mon.id);
    if (g?.enabled) return { cols: g.cols, rows: g.rows };
    return draftDims[mon.id] ?? (g ? { cols: g.cols, rows: g.rows } : DEFAULT_DIMS);
  }

  function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
  }

  function setDims(mon: MonitorInfo, cols: number, rows: number): void {
    cols = clamp(cols, 1, MAX_COLS);
    rows = clamp(rows, 1, MAX_ROWS);
    const g = gridFor(mon.id);
    if (g?.enabled) {
      void emitSettingsSetDims({ gridId: g.id, cols, rows });
    } else {
      draftDims[mon.id] = { cols, rows };
    }
  }

  function toggleGrid(mon: MonitorInfo, enabled: boolean): void {
    if (enabled) {
      const d = dimsFor(mon);
      void emitSettingsEnableGrid({ monitorId: mon.id, cols: d.cols, rows: d.rows });
    } else {
      const g = gridFor(mon.id);
      if (g) void emitSettingsDisableGrid({ gridId: g.id });
    }
  }

  /** "\\.\DISPLAY1@0,0" → "DISPLAY1". */
  function monName(m: MonitorInfo): string {
    const device = m.id.split('@')[0] ?? m.id;
    return device.replace(/^[\\.]+/, '') || m.id;
  }

  function dpiScale(m: MonitorInfo): number {
    return Math.round((m.dpi / 96) * 100);
  }

  const sortedMonitors = $derived(
    [...monitors].sort((a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x),
  );
</script>

<div class="page">
  <header>
    <div>
      <h1>Griddle WM</h1>
      <p class="tagline">Per-monitor window grids</p>
    </div>
    {#if snapshot?.paused}
      <span class="badge paused">Paused</span>
    {/if}
  </header>

  {#if sortedMonitors.length === 0}
    <p class="empty">Looking for monitors…</p>
  {/if}

  {#each sortedMonitors as mon (mon.id)}
    {@const grid = gridFor(mon.id)}
    {@const enabled = grid?.enabled ?? false}
    {@const dims = dimsFor(mon)}
    {@const tiles = (grid && snapshot?.tiles[grid.id]) || []}
    <section class="card">
      <div class="card-head">
        <div class="mon-info">
          <h2>{monName(mon)}</h2>
          <p class="meta">
            {mon.width}×{mon.height} · {dpiScale(mon)}%
            {#if mon.primary}<span class="badge">Primary</span>{/if}
          </p>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            checked={enabled}
            onchange={(e) => toggleGrid(mon, e.currentTarget.checked)}
          />
          <span class="track"><span class="thumb"></span></span>
          <span class="switch-label">{enabled ? 'Grid on' : 'Grid off'}</span>
        </label>
      </div>

      <div class="controls" class:dimmed={!enabled}>
        <div class="stepper">
          <span class="lbl">Columns</span>
          <button
            aria-label="Fewer columns"
            disabled={dims.cols <= 1}
            onclick={() => setDims(mon, dims.cols - 1, dims.rows)}>−</button
          >
          <span class="val">{dims.cols}</span>
          <button
            aria-label="More columns"
            disabled={dims.cols >= MAX_COLS}
            onclick={() => setDims(mon, dims.cols + 1, dims.rows)}>+</button
          >
        </div>
        <div class="stepper">
          <span class="lbl">Rows</span>
          <button
            aria-label="Fewer rows"
            disabled={dims.rows <= 1}
            onclick={() => setDims(mon, dims.cols, dims.rows - 1)}>−</button
          >
          <span class="val">{dims.rows}</span>
          <button
            aria-label="More rows"
            disabled={dims.rows >= MAX_ROWS}
            onclick={() => setDims(mon, dims.cols, dims.rows + 1)}>+</button
          >
        </div>
        {#if enabled && grid}
          <span class="mode-chip">{grid.mode}</span>
          <span class="tile-count">
            {tiles.length}
            {tiles.length === 1 ? 'window' : 'windows'}
          </span>
        {/if}
      </div>

      {#if enabled && grid}
        {#key `${grid.id}:${grid.cols}x${grid.rows}:${grid.mode}`}
          <GridEditor
            gridId={grid.id}
            cols={grid.cols}
            rows={grid.rows}
            mode={grid.mode}
            monitor={mon}
            {tiles}
          />
        {/key}
        <p class="hint">Drag tiles to rearrange the real windows.</p>
      {/if}
    </section>
  {/each}

  {#if snapshot && snapshot.floating.length > 0}
    <section class="card">
      <h2>Floating windows</h2>
      <p class="meta">These windows didn’t fit their grid and float free.</p>
      <ul class="floating">
        {#each snapshot.floating as f (f.hwnd)}
          <li><span class="ftitle">{f.title || `Window ${f.hwnd}`}</span> <code>{f.exe}</code></li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 28px 24px 48px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  h1 {
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.3px;
    margin: 0;
    color: var(--text-strong);
  }
  .tagline {
    margin: 2px 0 0;
    font-size: 13px;
    color: var(--text-dim);
  }

  .empty {
    color: var(--text-dim);
    font-size: 14px;
  }

  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    color: var(--text-strong);
  }
  .meta {
    margin: 2px 0 0;
    font-size: 12.5px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .badge {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(139, 124, 246, 0.16);
    color: var(--accent);
    border: 1px solid rgba(139, 124, 246, 0.35);
  }
  .badge.paused {
    background: rgba(246, 173, 85, 0.14);
    color: #f6ad55;
    border-color: rgba(246, 173, 85, 0.4);
  }

  /* Toggle switch */
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }
  .switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .track {
    width: 38px;
    height: 22px;
    border-radius: 999px;
    background: var(--well);
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    padding: 2px;
    box-sizing: border-box;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-dim);
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .switch input:checked + .track {
    background: rgba(139, 124, 246, 0.35);
    border-color: var(--accent);
  }
  .switch input:checked + .track .thumb {
    transform: translateX(15px);
    background: var(--accent);
  }
  .switch input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .switch-label {
    font-size: 13px;
    color: var(--text);
    min-width: 52px;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }
  .controls.dimmed {
    opacity: 0.55;
  }

  .stepper {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .stepper .lbl {
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .stepper button {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--well);
    color: var(--text-strong);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .stepper button:hover:not(:disabled) {
    border-color: var(--accent);
    background: rgba(139, 124, 246, 0.12);
  }
  .stepper button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .stepper .val {
    min-width: 22px;
    text-align: center;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }

  .mode-chip {
    font-size: 11px;
    font-weight: 600;
    text-transform: capitalize;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--well);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .tile-count {
    font-size: 12.5px;
    color: var(--text-dim);
    margin-left: auto;
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  .floating {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .floating li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }
  .ftitle {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .floating code {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-dim);
    background: var(--well);
    border-radius: 5px;
    padding: 2px 6px;
  }
</style>
