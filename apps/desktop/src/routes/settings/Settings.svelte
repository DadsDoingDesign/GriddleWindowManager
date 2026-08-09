<script lang="ts">
  // Settings window (plan Task 13): monitor cards with per-monitor grid
  // enable toggles and cols/rows steppers, plus the live GriddleGrid editor
  // bound to the brain's `state-snapshot`. All mutations go through
  // settings-* events to the brain page (contract §C2), which applies them
  // to real windows and persists the config.
  import { onDestroy, onMount } from 'svelte';
  import { getVersion } from '@tauri-apps/api/app';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import {
    DEFAULT_HOTKEY,
    unionWorkArea,
    type GridSettings,
    type MonitorInfo,
    type StateSnapshot,
    type WindowInfo,
  } from '@griddle-wm/brain';
  import {
    emitSettingsDisableGrid,
    emitSettingsEnableGrid,
    emitSettingsEnableSpan,
    emitSettingsReady,
    emitSettingsSetDims,
    emitSettingsSetExclusions,
    emitSettingsSetMode,
    emitSettingsSetPrefs,
    listMonitors,
    listWindows,
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
  /** Monitors ticked in the span-monitors multi-select (plan Task 17). */
  let spanSelection: Record<string, boolean> = $state({});
  /** Stepper values for the spanning grid about to be created. */
  let spanDraft = $state({ ...DEFAULT_DIMS });

  /**
   * Canonical accelerator → the spelling the docs teach: the shortcut plugin
   * needs 'Super' for the Windows key, but on a Windows-only product the UI
   * must answer in the user's language — display-map Super→Win everywhere
   * (normalizeHotkey maps it back on Apply).
   */
  function toDisplayHotkey(canonical: string): string {
    return canonical
      .split('+')
      .map((t) => (t.trim().toLowerCase() === 'super' ? 'Win' : t.trim()))
      .join('+');
  }
  const DISPLAY_DEFAULT_HOTKEY = toDisplayHotkey(DEFAULT_HOTKEY); // Ctrl+Win+G

  // General card (plan Task 18): autostart + hotkey (paused lives in the
  // snapshot). Initial values come from the persisted config; afterwards this
  // window is the only writer, so local state stays truthful. Hotkey state is
  // kept in display form ('Win'); only the emitted pref is canonical.
  let autostart = $state(false);
  let hotkeyDraft = $state(DISPLAY_DEFAULT_HOTKEY);
  let savedHotkey = $state(DISPLAY_DEFAULT_HOTKEY);
  let hotkeyError: string | null = $state(null);
  let appVersion = $state('');

  // Exclusions editor (plan Task 19). The snapshot is the truth; the config
  // read at mount only bridges the gap until the first snapshot arrives.
  let seedExclusions: string[] = $state([]);
  let exclusionDraft = $state('');
  let pickerOpen = $state(false);
  /** null while list_windows is in flight. */
  let pickerWindows: WindowInfo[] | null = $state(null);

  // First-run (plan Task 19): no config on disk yet — show the welcome page
  // until a grid gets enabled (or the user skips into the full settings).
  let firstRun = $state(false);
  let firstRunPick: string | null = $state(null);
  /**
   * Autostart offered at the point of first value (critique round 3): a
   * window manager that isn't running delivers nothing, so the first-run
   * card carries a pre-checked "Start with Windows" — the first config
   * write captures the choice instead of burying the toggle in General.
   */
  let firstRunAutostart = $state(true);

  let unlisteners: UnlistenFn[] = [];
  onMount(async () => {
    // Version next to the tagline: an unsigned app without auto-update needs
    // to tell the user which release they are on.
    getVersion()
      .then((v) => (appVersion = `v${v}`))
      .catch(() => {});
    unlisteners = await Promise.all([
      onStateSnapshot((s) => {
        snapshot = s;
        // The first enabled grid ends the first-run experience for good
        // (the brain persists it right after this snapshot).
        if (s.grids.some((g) => g.enabled)) firstRun = false;
      }),
      onMonitorsChanged((m) => (monitors = m)),
    ]);
    monitors = await listMonitors();
    firstRunPick =
      (monitors.find((m) => m.primary) ?? monitors[0])?.id ?? null;
    const cfg = await readConfig();
    if (cfg) {
      autostart = cfg.autostart;
      hotkeyDraft = toDisplayHotkey(cfg.hotkey);
      savedHotkey = toDisplayHotkey(cfg.hotkey);
      seedExclusions = cfg.exclusions;
    } else if (!snapshot?.grids.some((g) => g.enabled)) {
      firstRun = true;
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

  /** Live dims for an enabled grid, remembered dims for a disabled one. */
  function dimsFor(mon: MonitorInfo): { cols: number; rows: number } {
    const g = gridFor(mon.id);
    return g ? { cols: g.cols, rows: g.rows } : DEFAULT_DIMS;
  }

  function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
  }

  function setDims(mon: MonitorInfo, cols: number, rows: number): void {
    cols = clamp(cols, 1, MAX_COLS);
    rows = clamp(rows, 1, MAX_ROWS);
    const g = gridFor(mon.id);
    // The steppers are disabled while the grid is off, so this only ever
    // fires for an enabled grid.
    if (g?.enabled) void emitSettingsSetDims({ gridId: g.id, cols, rows });
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

  /**
   * Modifier tokens the accelerator grammar accepts, mapped to their
   * canonical spelling. 'Win' (the README's human name for the Windows key)
   * is an alias for 'Super' — typing the key the way the docs teach it must
   * just work.
   */
  const HOTKEY_MODIFIERS: Record<string, string> = {
    ctrl: 'Ctrl',
    control: 'Control',
    shift: 'Shift',
    alt: 'Alt',
    altgr: 'AltGr',
    option: 'Option',
    super: 'Super',
    meta: 'Meta',
    cmd: 'Cmd',
    command: 'Command',
    win: 'Super',
    windows: 'Super',
    commandorcontrol: 'CommandOrControl',
    cmdorctrl: 'CmdOrCtrl',
  };

  /**
   * Normalize + validate an accelerator draft before it ever reaches the
   * shell: canonicalize modifier spellings (mapping Win→Super), require at
   * least one modifier plus exactly one non-modifier key. Returns the
   * canonical string or an error message — a bad combination is refused
   * here with feedback instead of silently failing to register.
   */
  function normalizeHotkey(raw: string): { hotkey: string } | { error: string } {
    const tokens = raw
      .split('+')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    if (tokens.length === 0) return { error: 'Enter a key combination.' };
    const mods: string[] = [];
    for (const t of tokens.slice(0, -1)) {
      const mod = HOTKEY_MODIFIERS[t.toLowerCase()];
      if (mod === undefined) {
        return { error: `"${t}" is not a modifier — use Ctrl, Shift, Alt or Win.` };
      }
      mods.push(mod);
    }
    const key = tokens[tokens.length - 1]!;
    if (HOTKEY_MODIFIERS[key.toLowerCase()] !== undefined) {
      return { error: 'Finish the combination with a key, e.g. Ctrl+Win+G.' };
    }
    if (mods.length === 0) {
      return { error: 'Add at least one modifier (Ctrl, Shift, Alt or Win).' };
    }
    const canonicalKey =
      key.length === 1
        ? key.toUpperCase()
        : /^f([1-9]|1[0-9]|2[0-4])$/i.test(key)
          ? key.toUpperCase()
          : key[0]!.toUpperCase() + key.slice(1).toLowerCase();
    return { hotkey: [...mods, canonicalKey].join('+') };
  }

  function applyHotkey(): void {
    const raw = hotkeyDraft.trim();
    if (raw === '' || raw === savedHotkey) return;
    const result = normalizeHotkey(raw);
    if ('error' in result) {
      hotkeyError = result.error;
      return;
    }
    hotkeyError = null;
    // Store + display the docs' spelling; emit the canonical accelerator.
    savedHotkey = toDisplayHotkey(result.hotkey);
    hotkeyDraft = savedHotkey;
    void emitSettingsSetPrefs({ hotkey: result.hotkey });
  }

  // ── exclusions (plan Task 19) ────────────────────────────────────────────

  const exclusions = $derived.by(() => snapshot?.exclusions ?? seedExclusions);
  const sortedExclusions = $derived([...exclusions].sort());

  const draftExe = $derived(exclusionDraft.trim().toLowerCase());
  const draftValid = $derived(draftExe !== '' && !exclusions.includes(draftExe));

  function addExclusion(raw: string): void {
    const exe = raw.trim().toLowerCase();
    if (exe === '' || exclusions.includes(exe)) return;
    void emitSettingsSetExclusions({ exclusions: [...exclusions, exe] });
    exclusionDraft = '';
  }

  function removeExclusion(exe: string): void {
    void emitSettingsSetExclusions({
      exclusions: exclusions.filter((e) => e !== exe),
    });
  }

  function togglePicker(): void {
    pickerOpen = !pickerOpen;
    if (!pickerOpen) return;
    pickerWindows = null;
    listWindows()
      .then((ws) => (pickerWindows = ws))
      .catch((e) => {
        console.error('list_windows failed:', e);
        pickerWindows = [];
      });
  }

  interface PickerEntry {
    exe: string;
    titles: string;
  }

  /** Distinct exes of the open, still-manageable windows (excluded ones
   *  never come back from list_windows, but filter defensively). */
  const pickerEntries = $derived.by((): PickerEntry[] => {
    if (pickerWindows === null) return [];
    const byExe = new Map<string, string[]>();
    for (const w of pickerWindows) {
      if (exclusions.includes(w.exe)) continue;
      const titles = byExe.get(w.exe) ?? [];
      if (w.title !== '' && titles.length < 3) titles.push(w.title);
      byExe.set(w.exe, titles);
    }
    return [...byExe.entries()]
      .map(([exe, titles]) => ({ exe, titles: titles.join(' · ') }))
      .sort((a, b) => a.exe.localeCompare(b.exe));
  });

  // ── first run (plan Task 19) ─────────────────────────────────────────────

  function enableFirstRun(): void {
    if (firstRunPick === null) return;
    if (firstRunAutostart) {
      // Same path as the General toggle — the brain persists it with the
      // grid it is about to enable, so one config write captures both.
      autostart = true;
      void emitSettingsSetPrefs({ autostart: true });
    }
    void emitSettingsEnableGrid({
      monitorId: firstRunPick,
      cols: DEFAULT_DIMS.cols,
      rows: DEFAULT_DIMS.rows,
    });
  }
</script>

<div class="page">
  {#if firstRun}
    <header>
      <div>
        <h1>Griddle WM</h1>
        <p class="tagline">
          Window grids for your desktop{#if appVersion}
            <span class="version">{appVersion}</span>{/if}
        </p>
      </div>
    </header>

    <section class="card first-run">
      <h2>Put your windows on a grid</h2>
      <p class="fr-copy">
        Enable a grid on a monitor and every window there gets its own cell.
        Drag a window and a faint grid fades in with a live preview of where
        it will land and how its neighbors make room — nothing moves until
        you let go. Reshape the grid, choose whether windows push each other
        aside (Tile) or stack freely (Stack), save layouts as templates,
        exclude apps you'd rather leave alone, and pause everything from the
        tray whenever you want your desktop back.
      </p>

      {#if sortedMonitors.length === 0}
        <p class="hint">Looking for monitors…</p>
      {:else}
        <div class="fr-monitors" role="radiogroup" aria-label="Monitor to grid">
          {#each sortedMonitors as mon (mon.id)}
            <label class="fr-mon" class:selected={firstRunPick === mon.id}>
              <input
                type="radio"
                name="first-run-monitor"
                value={mon.id}
                checked={firstRunPick === mon.id}
                onchange={() => (firstRunPick = mon.id)}
              />
              <span class="fr-mon-name">{monName(mon)}</span>
              <span class="fr-mon-meta">
                {mon.width}×{mon.height}{mon.primary ? ' · primary' : ''}
              </span>
            </label>
          {/each}
        </div>
      {/if}

      <label class="pick">
        <input type="checkbox" bind:checked={firstRunAutostart} />
        <span>Start with Windows — keep your grids working after a reboot</span>
      </label>

      <div class="controls">
        <button
          class="primary"
          disabled={firstRunPick === null}
          onclick={enableFirstRun}>Enable grid</button
        >
        <span class="hint">
          Starts as a 12×6 grid — your windows on this monitor snap into
          place right away, and you can change everything later.
        </span>
        <!-- Honest label: this page never returns (the first config write
             ends first-run for good) — skipping simply lands on the full
             settings page, where every enable toggle lives. -->
        <button class="quiet" onclick={() => (firstRun = false)}>
          Skip to Settings
        </button>
      </div>
      <p class="hint">
        Griddle WM lives in the system tray — closing this window keeps your
        grids running.
      </p>
    </section>
  {:else}
  <header>
    <div>
      <h1>Griddle WM</h1>
      <p class="tagline">
        Window grids for your desktop{#if appVersion}
          <span class="version">{appVersion}</span>{/if}
      </p>
    </div>
    <!-- Pause is the panic button (spec §6) — it lives where a stressed
         user looks first, not at the bottom of General. -->
    <div class="header-pause">
      {#if snapshot?.paused}
        <span class="badge paused">Paused</span>
      {/if}
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
            disabled={!enabled || dims.cols <= 1}
            onclick={() => setDims(mon, dims.cols - 1, dims.rows)}>−</button
          >
          <span class="val">{dims.cols}</span>
          <button
            aria-label="More columns"
            disabled={!enabled || dims.cols >= MAX_COLS}
            onclick={() => setDims(mon, dims.cols + 1, dims.rows)}>+</button
          >
        </div>
        <div class="stepper">
          <span class="lbl">Rows</span>
          <button
            aria-label="Fewer rows"
            disabled={!enabled || dims.rows <= 1}
            onclick={() => setDims(mon, dims.cols, dims.rows - 1)}>−</button
          >
          <span class="val">{dims.rows}</span>
          <button
            aria-label="More rows"
            disabled={!enabled || dims.rows >= MAX_ROWS}
            onclick={() => setDims(mon, dims.cols, dims.rows + 1)}>+</button
          >
        </div>
        {#if enabled && grid}
          <div class="segmented" role="group" aria-label="Grid mode">
            <button
              class:active={grid.mode === 'collision'}
              aria-pressed={grid.mode === 'collision'}
              title="Windows push each other aside — never overlap"
              onclick={() => setMode(grid, 'collision')}>Tile</button
            >
            <button
              class:active={grid.mode === 'overlay'}
              aria-pressed={grid.mode === 'overlay'}
              title="Windows snap to cells and may overlap"
              onclick={() => setMode(grid, 'overlay')}>Stack</button
            >
          </div>
          <span class="tile-count">
            {tiles.length}
            {tiles.length === 1 ? 'window' : 'windows'}
          </span>
        {/if}
      </div>
      {#if enabled && grid && !spanned}
        <p class="hint">
          {grid.mode === 'collision'
            ? 'Tile: windows push each other aside — they never overlap.'
            : 'Stack: windows snap to cells and may overlap — the most recent stays on top.'}
        </p>
      {/if}

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
          gridCols={grid.cols}
          gridRows={grid.rows}
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
          <h2>
            Spanning: {grid.monitorIds.map(monNameFromId).join(' + ')}
            <span class="badge experimental">Experimental</span>
          </h2>
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
            title="Windows push each other aside — never overlap"
            onclick={() => setMode(grid, 'collision')}>Tile</button
          >
          <button
            class:active={grid.mode === 'overlay'}
            aria-pressed={grid.mode === 'overlay'}
            title="Windows snap to cells and may overlap"
            onclick={() => setMode(grid, 'overlay')}>Stack</button
          >
        </div>
        <span class="tile-count">
          {tiles.length}
          {tiles.length === 1 ? 'window' : 'windows'}
        </span>
      </div>
      <p class="hint">
        {grid.mode === 'collision'
          ? 'Tile: windows push each other aside — they never overlap.'
          : 'Stack: windows snap to cells and may overlap — the most recent stays on top.'}
      </p>

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
          gridCols={grid.cols}
          gridRows={grid.rows}
        />
      {/if}
    </section>
  {/each}

  {#if sortedMonitors.length >= 2}
    <section class="card">
      <div class="card-head">
        <div class="mon-info">
          <h2>Span monitors <span class="badge experimental">Experimental</span></h2>
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
      <p class="hint">
        Spanning is the newest feature and has had the least real-world
        testing — please report anything odd.
      </p>
    </section>
  {/if}

  <!-- General sits above Excluded apps (critique round 3): startup and the
       hotkey are universal settings; exclusions are an edge-case tool. -->
  <section class="card">
    <div class="card-head">
      <div class="mon-info">
        <h2>General</h2>
        <p class="meta">Startup and the settings hotkey.</p>
      </div>
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
          placeholder={DISPLAY_DEFAULT_HOTKEY}
          spellcheck="false"
          oninput={() => (hotkeyError = null)}
          onkeydown={(e) => {
            if (e.key === 'Enter') applyHotkey();
          }}
        />
      </label>
      <button class="primary" disabled={!hotkeyDirty} onclick={applyHotkey}>
        Apply
      </button>
    </div>
    {#if hotkeyError}
      <p class="hint error">{hotkeyError}</p>
    {/if}
    <p class="hint">
      Global shortcut that opens this window — e.g. Ctrl+Win+G. If another
      app already owns the new combination, the previous one stays active.
    </p>
  </section>

  <section class="card">
    <div class="card-head">
      <div class="mon-info">
        <h2>Excluded apps</h2>
        <p class="meta">Windows from these programs are never managed.</p>
      </div>
    </div>
    {#if sortedExclusions.length > 0}
      <ul class="excl-list">
        {#each sortedExclusions as exe (exe)}
          <li class="excl-chip">
            <code>{exe}</code>
            <button
              class="chip-x"
              aria-label={`Stop excluding ${exe}`}
              title="Stop excluding"
              onclick={() => removeExclusion(exe)}>×</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <p class="hint">Nothing is excluded — every eligible window is managed.</p>
    {/if}
    <div class="controls">
      <label class="field">
        <span class="lbl">Program</span>
        <input
          class="excl-input"
          type="text"
          placeholder="e.g. slack.exe"
          bind:value={exclusionDraft}
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === 'Enter') addExclusion(exclusionDraft);
          }}
        />
      </label>
      <button
        class="primary"
        disabled={!draftValid}
        onclick={() => addExclusion(exclusionDraft)}>Exclude</button
      >
      <button class="quiet" onclick={togglePicker}>
        {pickerOpen ? 'Hide open windows' : 'Pick from open windows'}
      </button>
    </div>
    {#if pickerOpen}
      {#if pickerWindows === null}
        <p class="hint">Looking at open windows…</p>
      {:else if pickerEntries.length === 0}
        <p class="hint">No manageable windows are open right now.</p>
      {:else}
        <ul class="pick-list">
          {#each pickerEntries as entry (entry.exe)}
            <li>
              <button class="pick-row" onclick={() => addExclusion(entry.exe)}>
                <code>{entry.exe}</code>
                <span class="pick-titles">{entry.titles}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    <p class="hint">
      Excluding a program releases its windows immediately — they stay exactly
      where they are. Remove an entry and its windows are managed again.
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
      <!-- The one card that names a problem must also name the way out.
           These are the real retry triggers (brain reflowGrid /
           applyTemplate / windowRestored) — not guesses. -->
      <p class="hint">
        Make room — add rows or columns, or apply a template — and they'll be
        placed right away. Minimizing and restoring a floating window also
        retries its placement.
      </p>
    </section>
  {/if}
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
  .header-pause {
    display: inline-flex;
    align-items: center;
    gap: 12px;
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
  .version {
    margin-left: 8px;
    font-size: 11.5px;
    font-family: var(--mono);
    color: var(--text-dim);
    opacity: 0.8;
  }
  .hint.error {
    color: #f66a6a;
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
  .badge.experimental {
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

  .quiet {
    border: 1px solid var(--border);
    border-radius: 9px;
    background: transparent;
    color: var(--text-dim);
    font: 600 12.5px/1 var(--sans);
    padding: 8px 14px;
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .quiet:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  /* First-run (plan Task 19) */
  .first-run h2 {
    font-size: 17px;
  }
  .fr-copy {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text);
    max-width: 58ch;
  }
  .fr-monitors {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .fr-mon {
    display: flex;
    flex-direction: column;
    gap: 3px;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: var(--well);
    padding: 12px 16px;
    min-width: 150px;
    cursor: pointer;
    user-select: none;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .fr-mon:hover {
    border-color: var(--accent);
  }
  .fr-mon.selected {
    border-color: var(--accent);
    background: rgba(139, 124, 246, 0.12);
  }
  .fr-mon input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .fr-mon:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .fr-mon-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .fr-mon-meta {
    font-size: 12px;
    color: var(--text-dim);
  }

  /* Exclusions editor (plan Task 19) */
  .excl-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .excl-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--well);
    padding: 4px 6px 4px 12px;
  }
  .excl-chip code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
  }
  .chip-x {
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .chip-x:hover {
    background: rgba(246, 106, 106, 0.18);
    color: #f66a6a;
  }
  .chip-x:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .excl-input {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--well);
    color: var(--text-strong);
    font: 500 13px/1.2 var(--mono);
    padding: 7px 10px;
    width: 200px;
  }
  .excl-input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .pick-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 220px;
    overflow-y: auto;
  }
  .pick-row {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    padding: 6px 10px;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .pick-row:hover {
    background: rgba(139, 124, 246, 0.1);
    border-color: var(--border);
  }
  .pick-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .pick-row code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-strong);
    white-space: nowrap;
  }
  .pick-titles {
    font-size: 12px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
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
