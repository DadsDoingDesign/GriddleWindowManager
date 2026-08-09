<script lang="ts">
  // Settings window (plan Task 13): monitor cards with per-monitor grid
  // enable toggles and cols/rows steppers, plus the live GriddleGrid editor
  // bound to the brain's `state-snapshot`. All mutations go through
  // settings-* events to the brain page (contract §C2), which applies them
  // to real windows and persists the config.
  import { onDestroy, onMount } from 'svelte';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import {
    DEFAULT_HOTKEY,
    unionWorkArea,
    type GridSettings,
    type MonitorInfo,
    type StateSnapshot,
  } from '@griddle-wm/brain';
  import {
    emitSettingsDisableGrid,
    emitSettingsEnableGrid,
    emitSettingsEnableSpan,
    emitSettingsReady,
    emitSettingsSetDims,
    emitSettingsSetMode,
    emitSettingsSetPrefs,
    listMonitors,
    onMonitorsChanged,
    onStateSnapshot,
    readConfig,
    setPaused,
  } from '../../lib/ipc';
  import GridEditor from './GridEditor.svelte';
  import TemplateGallery from './TemplateGallery.svelte';

  const MAX_COLS = 32;
  const MAX_ROWS = 16;
  const DEFAULT_DIMS = { cols: 12, rows: 6 };

  let monitors: MonitorInfo[] = $state([]);
  let snapshot: StateSnapshot | null = $state(null);
  /** Stepper values for monitors whose grid is not currently enabled. */
  let draftDims: Record<string, { cols: number; rows: number }> = $state({});
  /** Monitors ticked in the span-monitors multi-select (plan Task 17). */
  let spanSelection: Record<string, boolean> = $state({});
  /** Stepper values for the spanning grid about to be created. */
  let spanDraft = $state({ ...DEFAULT_DIMS });

  // General card (plan Task 18): autostart + hotkey (paused lives in the
  // snapshot). Initial values come from the persisted config; afterwards this
  // window is the only writer, so local state stays truthful.
  let autostart = $state(false);
  let hotkeyDraft = $state(DEFAULT_HOTKEY);
  let savedHotkey = $state(DEFAULT_HOTKEY);

  let unlisteners: UnlistenFn[] = [];
  onMount(async () => {
    unlisteners = await Promise.all([
      onStateSnapshot((s) => (snapshot = s)),
      onMonitorsChanged((m) => (monitors = m)),
    ]);
    monitors = await listMonitors();
    const cfg = await readConfig();
    if (cfg) {
      autostart = cfg.autostart;
      hotkeyDraft = cfg.hotkey;
      savedHotkey = cfg.hotkey;
    }
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

  /** Live spanning grids (plan Task 17). */
  const spanGrids = $derived.by(() =>
    (snapshot?.grids ?? []).filter((g) => g.monitorIds.length > 1 && g.enabled),
  );

  /** The enabled spanning grid covering a monitor, if any. */
  function spanFor(monitorId: string): GridSettings | undefined {
    return spanGrids.find((g) => g.monitorIds.includes(monitorId));
  }

  /** Present member monitors of a spanning grid, in its monitorIds order. */
  function spanMonitors(g: GridSettings): MonitorInfo[] {
    return g.monitorIds
      .map((id) => monitors.find((m) => m.id === id))
      .filter((m): m is MonitorInfo => m !== undefined);
  }

  const spanSelected = $derived(
    monitors.filter((m) => spanSelection[m.id] === true).map((m) => m.id),
  );

  function createSpan(): void {
    if (spanSelected.length < 2) return;
    void emitSettingsEnableSpan({
      monitorIds: spanSelected,
      cols: spanDraft.cols,
      rows: spanDraft.rows,
    });
    spanSelection = {};
  }

  function setSpanDims(grid: GridSettings, cols: number, rows: number): void {
    cols = clamp(cols, 1, MAX_COLS);
    rows = clamp(rows, 1, MAX_ROWS);
    void emitSettingsSetDims({ gridId: grid.id, cols, rows });
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

  function setMode(grid: GridSettings, mode: 'collision' | 'overlay'): void {
    if (grid.mode === mode) return;
    void emitSettingsSetMode({ gridId: grid.id, mode });
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
  function monNameFromId(id: string): string {
    const device = id.split('@')[0] ?? id;
    return device.replace(/^[\\.]+/, '') || id;
  }

  function monName(m: MonitorInfo): string {
    return monNameFromId(m.id);
  }

  function dpiScale(m: MonitorInfo): number {
    return Math.round((m.dpi / 96) * 100);
  }

  const sortedMonitors = $derived(
    [...monitors].sort((a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x),
  );

  function togglePaused(paused: boolean): void {
    // Rust owns the pause flag; the resulting `paused-changed` round-trips
    // through the brain and lands back here via the snapshot.
    void setPaused(paused);
  }

  function toggleAutostart(enabled: boolean): void {
    autostart = enabled;
    void emitSettingsSetPrefs({ autostart: enabled });
  }

  const hotkeyDirty = $derived(
    hotkeyDraft.trim() !== '' && hotkeyDraft.trim() !== savedHotkey,
  );

  function applyHotkey(): void {
    const hotkey = hotkeyDraft.trim();
    if (hotkey === '' || hotkey === savedHotkey) return;
    savedHotkey = hotkey;
    hotkeyDraft = hotkey;
    void emitSettingsSetPrefs({ hotkey });
  }
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
    {@const spanned = spanFor(mon.id)}
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
            {#if spanned}<span class="badge">Spanned</span>{/if}
          </p>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={spanned !== undefined}
            onchange={(e) => toggleGrid(mon, e.currentTarget.checked)}
          />
          <span class="track"><span class="thumb"></span></span>
          <span class="switch-label">
            {spanned ? 'Spanned' : enabled ? 'Grid on' : 'Grid off'}
          </span>
        </label>
      </div>
      {#if spanned}
        <p class="hint">
          This monitor is part of a spanning grid — disable that grid to manage
          it on its own.
        </p>
      {/if}

      <div class="controls" class:dimmed={!enabled} class:hidden={spanned !== undefined}>
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
          <div class="segmented" role="group" aria-label="Grid mode">
            <button
              class:active={grid.mode === 'collision'}
              aria-pressed={grid.mode === 'collision'}
              title="Windows push each other aside — no overlap"
              onclick={() => setMode(grid, 'collision')}>Collision</button
            >
            <button
              class:active={grid.mode === 'overlay'}
              aria-pressed={grid.mode === 'overlay'}
              title="Windows snap to cells but may overlap"
              onclick={() => setMode(grid, 'overlay')}>Overlay</button
            >
          </div>
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
        <TemplateGallery
          gridId={grid.id}
          templates={snapshot?.templates ?? []}
          activeTemplateId={grid.activeTemplateId}
          tileCount={tiles.length}
        />
      {/if}
    </section>
  {/each}

  {#each spanGrids as grid (grid.id)}
    {@const members = spanMonitors(grid)}
    {@const union =
      members.length === grid.monitorIds.length ? unionWorkArea(members) : null}
    {@const tiles = snapshot?.tiles[grid.id] ?? []}
    <section class="card">
      <div class="card-head">
        <div class="mon-info">
          <h2>Spanning: {grid.monitorIds.map(monNameFromId).join(' + ')}</h2>
          <p class="meta">
            {#if union}
              {union.workWidth}×{union.workHeight} union work area
            {:else}
              A member monitor is disconnected — grid resumes when it returns.
            {/if}
          </p>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            checked={true}
            onchange={() => void emitSettingsDisableGrid({ gridId: grid.id })}
          />
          <span class="track"><span class="thumb"></span></span>
          <span class="switch-label">Grid on</span>
        </label>
      </div>

      <div class="controls">
        <div class="stepper">
          <span class="lbl">Columns</span>
          <button
            aria-label="Fewer columns"
            disabled={grid.cols <= 1}
            onclick={() => setSpanDims(grid, grid.cols - 1, grid.rows)}>−</button
          >
          <span class="val">{grid.cols}</span>
          <button
            aria-label="More columns"
            disabled={grid.cols >= MAX_COLS}
            onclick={() => setSpanDims(grid, grid.cols + 1, grid.rows)}>+</button
          >
        </div>
        <div class="stepper">
          <span class="lbl">Rows</span>
          <button
            aria-label="Fewer rows"
            disabled={grid.rows <= 1}
            onclick={() => setSpanDims(grid, grid.cols, grid.rows - 1)}>−</button
          >
          <span class="val">{grid.rows}</span>
          <button
            aria-label="More rows"
            disabled={grid.rows >= MAX_ROWS}
            onclick={() => setSpanDims(grid, grid.cols, grid.rows + 1)}>+</button
          >
        </div>
        <div class="segmented" role="group" aria-label="Grid mode">
          <button
            class:active={grid.mode === 'collision'}
            aria-pressed={grid.mode === 'collision'}
            title="Windows push each other aside — no overlap"
            onclick={() => setMode(grid, 'collision')}>Collision</button
          >
          <button
            class:active={grid.mode === 'overlay'}
            aria-pressed={grid.mode === 'overlay'}
            title="Windows snap to cells but may overlap"
            onclick={() => setMode(grid, 'overlay')}>Overlay</button
          >
        </div>
        <span class="tile-count">
          {tiles.length}
          {tiles.length === 1 ? 'window' : 'windows'}
        </span>
      </div>

      {#if union}
        {#key `${grid.id}:${grid.cols}x${grid.rows}:${grid.mode}`}
          <GridEditor
            gridId={grid.id}
            cols={grid.cols}
            rows={grid.rows}
            mode={grid.mode}
            monitor={union}
            {tiles}
          />
        {/key}
        <p class="hint">
          Drag tiles to rearrange the real windows. Cells over the gap of an
          L-shaped union are dead space — drops there snap to the nearest
          usable slot.
        </p>
        <TemplateGallery
          gridId={grid.id}
          templates={snapshot?.templates ?? []}
          activeTemplateId={grid.activeTemplateId}
          tileCount={tiles.length}
        />
      {/if}
    </section>
  {/each}

  {#if sortedMonitors.length >= 2}
    <section class="card">
      <div class="card-head">
        <div class="mon-info">
          <h2>Span monitors</h2>
          <p class="meta">
            One grid across several monitors. Per-monitor grids on the selected
            monitors are replaced by the spanning grid.
          </p>
        </div>
      </div>
      <div class="controls">
        {#each sortedMonitors as mon (mon.id)}
          <label class="pick">
            <input
              type="checkbox"
              checked={spanSelection[mon.id] === true}
              onchange={(e) =>
                (spanSelection = {
                  ...spanSelection,
                  [mon.id]: e.currentTarget.checked,
                })}
            />
            <span>{monName(mon)}</span>
          </label>
        {/each}
      </div>
      <div class="controls">
        <div class="stepper">
          <span class="lbl">Columns</span>
          <button
            aria-label="Fewer columns"
            disabled={spanDraft.cols <= 1}
            onclick={() => (spanDraft.cols = clamp(spanDraft.cols - 1, 1, MAX_COLS))}
            >−</button
          >
          <span class="val">{spanDraft.cols}</span>
          <button
            aria-label="More columns"
            disabled={spanDraft.cols >= MAX_COLS}
            onclick={() => (spanDraft.cols = clamp(spanDraft.cols + 1, 1, MAX_COLS))}
            >+</button
          >
        </div>
        <div class="stepper">
          <span class="lbl">Rows</span>
          <button
            aria-label="Fewer rows"
            disabled={spanDraft.rows <= 1}
            onclick={() => (spanDraft.rows = clamp(spanDraft.rows - 1, 1, MAX_ROWS))}
            >−</button
          >
          <span class="val">{spanDraft.rows}</span>
          <button
            aria-label="More rows"
            disabled={spanDraft.rows >= MAX_ROWS}
            onclick={() => (spanDraft.rows = clamp(spanDraft.rows + 1, 1, MAX_ROWS))}
            >+</button
          >
        </div>
        <button class="primary" disabled={spanSelected.length < 2} onclick={createSpan}>
          Create spanning grid
        </button>
      </div>
      {#if spanSelected.length === 1}
        <p class="hint">Select at least two monitors to span.</p>
      {/if}
    </section>
  {/if}

  <section class="card">
    <div class="card-head">
      <div class="mon-info">
        <h2>General</h2>
        <p class="meta">Pause, startup and the settings hotkey.</p>
      </div>
    </div>
    <div class="controls">
      <label class="switch">
        <input
          type="checkbox"
          checked={snapshot?.paused ?? false}
          onchange={(e) => togglePaused(e.currentTarget.checked)}
        />
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label wide">Pause window management</span>
      </label>
    </div>
    <div class="controls">
      <label class="switch">
        <input
          type="checkbox"
          checked={autostart}
          onchange={(e) => toggleAutostart(e.currentTarget.checked)}
        />
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label wide">Start with Windows</span>
      </label>
    </div>
    <div class="controls">
      <label class="field">
        <span class="lbl">Settings hotkey</span>
        <input
          class="hotkey-input"
          type="text"
          bind:value={hotkeyDraft}
          placeholder={DEFAULT_HOTKEY}
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === 'Enter') applyHotkey();
          }}
        />
      </label>
      <button class="primary" disabled={!hotkeyDirty} onclick={applyHotkey}>
        Apply
      </button>
    </div>
    <p class="hint">
      Global shortcut that opens this window — e.g. Ctrl+Super+G (Super is the
      Windows key). If the new combination cannot be registered, the previous
      one stays active.
    </p>
  </section>

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
  .switch-label.wide {
    min-width: 0;
  }

  .field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .field .lbl {
    font-size: 12.5px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .hotkey-input {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--well);
    color: var(--text-strong);
    font: 500 13px/1.2 var(--mono);
    padding: 7px 10px;
    width: 180px;
  }
  .hotkey-input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
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
  .controls.hidden {
    display: none;
  }

  .pick {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }
  .pick input {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
    cursor: pointer;
  }

  .primary {
    border: 1px solid var(--accent);
    border-radius: 9px;
    background: rgba(139, 124, 246, 0.18);
    color: var(--accent);
    font: 600 12.5px/1 var(--sans);
    padding: 8px 14px;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .primary:hover:not(:disabled) {
    background: rgba(139, 124, 246, 0.28);
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: default;
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

  .segmented {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--well);
    padding: 2px;
    gap: 2px;
  }
  .segmented button {
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text-dim);
    font: 600 12px/1 var(--sans);
    padding: 5px 12px;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .segmented button:hover:not(.active) {
    color: var(--text);
    background: rgba(255, 255, 255, 0.04);
  }
  .segmented button.active {
    background: rgba(139, 124, 246, 0.22);
    color: var(--accent);
    cursor: default;
  }
  .segmented button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
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
