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
    MAX_SPACING_PX,
    canCheckNow,
    downloadFraction,
    effectiveSpacing,
    initialUpdateState,
    unionWorkArea,
    type AppRule,
    type GridSettings,
    type MonitorInfo,
    type PlacementMode,
    type Slot,
    type StateSnapshot,
    type UpdateState,
    type View,
    type WindowInfo,
  } from '@griddle-wm/brain';
  import {
    emitSettingsApplyView,
    emitSettingsCaptureView,
    emitSettingsCheckUpdates,
    emitSettingsDeleteView,
    emitSettingsDismissUpdate,
    emitSettingsInstallUpdate,
    emitSettingsDisableGrid,
    emitSettingsEnableGrid,
    emitSettingsEnableSpan,
    emitSettingsReady,
    emitSettingsRemoveAppRule,
    emitSettingsRenameView,
    emitSettingsSetDims,
    emitSettingsSetExclusions,
    emitSettingsSetMode,
    emitSettingsSetPrefs,
    emitSettingsSetSpacing,
    emitSettingsSetStartupView,
    listMonitors,
    hideSettings,
    listWindows,
    onMonitorsChanged,
    onStateSnapshot,
    onUpdateState,
    readConfig,
    setPaused,
  } from '../../lib/ipc';
  import GridEditor from './GridEditor.svelte';
  import NumberField from './NumberField.svelte';
  import PlacementPicker from './PlacementPicker.svelte';
  import TemplateGallery from './TemplateGallery.svelte';

  const MAX_COLS = 32;
  const MAX_ROWS = 16;
  const DEFAULT_DIMS = { cols: 12, rows: 6 };
  /**
   * Gap/padding stepper increment (spec v0.2 §1: range 0–64). 4px per click
   * walks the whole range in 16 steps and lands on the spacing values people
   * actually use; the brain accepts any integer in range.
   */
  const SPACING_STEP = 4;
  /**
   * Press-and-hold auto-repeat for every stepper button (critique round):
   * 4px per click meant 16 clicks to cross the 0–64 spacing range, and
   * cols/rows had the same problem. Hold delay is long enough that a normal
   * click never repeats.
   */
  const HOLD_DELAY_MS = 400;
  const HOLD_REPEAT_MS = 110;

  /**
   * Svelte action: while the button is held down, keep running `run` after a
   * short delay. The button's own `onclick` still fires once on release, so a
   * plain click behaves exactly as before. Repeating stops the moment the
   * button becomes disabled (a stepper hitting its bound), on pointer
   * release/cancel anywhere, and when the window loses focus.
   */
  function holdRepeat(node: HTMLButtonElement, run: () => void) {
    let fire = run;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let repeatTimer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (startTimer !== null) clearTimeout(startTimer);
      if (repeatTimer !== null) clearInterval(repeatTimer);
      startTimer = null;
      repeatTimer = null;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || node.disabled) return;
      stop();
      startTimer = setTimeout(() => {
        startTimer = null;
        repeatTimer = setInterval(() => {
          if (node.disabled) {
            stop();
            return;
          }
          fire();
        }, HOLD_REPEAT_MS);
      }, HOLD_DELAY_MS);
    };
    node.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return {
      update(next: () => void) {
        fire = next;
      },
      destroy() {
        stop();
        node.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        window.removeEventListener('blur', stop);
      },
    };
  }

  let monitors: MonitorInfo[] = $state([]);
  /**
   * Eligible windows per monitor id, for the first-run picker: how many are
   * there at all, and how many a grid could actually take right now.
   *
   * Enabling a grid that then does nothing visible is the single most
   * misleading thing this app can do (docs/qa-handoff-2026-08-19.md, defect
   * 3), and there are two separate ways to walk into it: pick a monitor with
   * no windows, or pick one whose windows are all maximized. `enableGrid`
   * skips both — it sweeps only matching, non-`minimized` windows, and
   * `minimized` is `IsIconic || WS_MAXIMIZE`, so a maximized window is
   * invisible to it. Saying which case you are in costs one `list_windows`
   * call, which the settings window is already allowed to make. `null` while
   * still unknown, so the hint never guesses.
   */
  let monitorWindowCounts: Record<string, { total: number; tileable: number }> | null =
    $state(null);
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
  /**
   * Suppress Windows' own drag-to-edge snapping while Griddle runs (spec
   * 2026-08-19). Same single-writer shape as autostart. Mirrors the config;
   * the OS side effect lives in Rust.
   */
  let suppressWindowsSnap = $state(false);
  /** Spec 2026-08-20 addendum: let Griddle tile this pop-out like any window. */
  let manageSettingsWindow = $state(false);
  /** Templates live behind a button on the manager row (Figma 110-344). */
  let templatesOpen = $state(false);
  /**
   * Widget appearance. Applied to the document element, because the palette
   * lives on `:root` in settings.css — the whole window reskins, not just the
   * band table. Dark is the default and what an absent preference means.
   */
  let theme = $state<'dark' | 'light'>('dark');
  /** Measured size of the map band, so the editor can fit itself to it. */
  let mapW = $state(0);
  let mapH = $state(0);
  function applyTheme(next: 'dark' | 'light'): void {
    theme = next;
    document.documentElement.dataset.theme = next;
  }
  function toggleTheme(): void {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    void emitSettingsSetPrefs({ theme: next });
  }
  let firstRunSuppressSnap = $state(false);
  let hotkeyDraft = $state(DISPLAY_DEFAULT_HOTKEY);
  let savedHotkey = $state(DISPLAY_DEFAULT_HOTKEY);
  let hotkeyError: string | null = $state(null);
  let appVersion = $state('');

  // Updates card (spec §7). The toggle is seeded from the persisted config
  // like autostart — this window is its only writer. The rest of the state
  // is broadcast by the brain host, which owns the whole update flow; this
  // page never talks to the updater itself.
  let autoCheckUpdates = $state(false);
  let update: UpdateState = $state(initialUpdateState());

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
      onUpdateState((s) => (update = s)),
    ]);
    monitors = await listMonitors();
    firstRunPick =
      (monitors.find((m) => m.primary) ?? monitors[0])?.id ?? null;
    void refreshMonitorWindowCounts();
    const cfg = await readConfig();
    if (cfg) {
      autostart = cfg.autostart;
      suppressWindowsSnap = cfg.suppressWindowsSnap;
      manageSettingsWindow = cfg.manageSettingsWindow;
      applyTheme(cfg.theme === 'light' ? 'light' : 'dark');
      hotkeyDraft = toDisplayHotkey(cfg.hotkey);
      savedHotkey = toDisplayHotkey(cfg.hotkey);
      seedExclusions = cfg.exclusions;
      autoCheckUpdates = cfg.autoCheckUpdates;
    } else if (!snapshot?.grids.some((g) => g.enabled)) {
      firstRun = true;
    }
    // Ask the brain to re-emit its latest snapshot for this fresh window.
    await emitSettingsReady();
  });
  onDestroy(() => {
    for (const u of unlisteners) u();
    if (viewDisarmTimer !== null) clearTimeout(viewDisarmTimer);
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

  /**
   * The three placement modes, in the order the dropdown lists them: the one
   * most people want first, then the two that trade its cleverness away.
   * `blurb` is the one-line description on the option row — it has to survive
   * being the *only* thing a closed dropdown shows, so it stays short; `hint`
   * is the fuller sentence printed under the control for whichever mode is
   * selected.
   */
  const PLACEMENT_MODES: {
    value: PlacementMode;
    label: string;
    blurb: string;
    hint: string;
  }[] = [
    {
      value: 'reflow',
      label: 'Reflow',
      blurb: 'others rearrange around it',
      hint:
        'Reflow: a dropped window lands exactly where you aimed, and as few ' +
        'other windows as possible move aside to make room.',
    },
    {
      value: 'push',
      label: 'Push',
      blurb: 'it shoves neighbors aside',
      hint:
        'Push: a dropped window shoves its neighbors out of the way one at a ' +
        'time — if they have nowhere to go, the drop is refused.',
    },
    {
      value: 'stack',
      label: 'Stack',
      blurb: 'windows may overlap',
      hint:
        'Stack: windows snap to cells but may overlap — the most recent ' +
        'stays on top.',
    },
  ];

  function modeHint(mode: PlacementMode): string {
    return PLACEMENT_MODES.find((m) => m.value === mode)?.hint ?? '';
  }

  function setMode(grid: GridSettings, mode: PlacementMode): void {
    if (grid.mode === mode) return;
    void emitSettingsSetMode({ gridId: grid.id, mode });
  }

  /**
   * A grid's stored gap/padding *and* the gap actually in force (critique
   * round). When `gap*(cols-1)` would leave cells under 16px the brain
   * coerces the gap down (spec v0.2 §1) — the editor preview and the desktop
   * then show a smaller gutter than the stepper's stored number. Surfacing
   * both keeps the stepper from disagreeing with the pixels underneath it.
   */
  interface SpacingView {
    gap: number;
    padding: number;
    effGapX: number;
    effGapY: number;
    coerced: boolean;
  }

  function spacingView(
    mon: MonitorInfo | null,
    g: GridSettings | undefined,
  ): SpacingView {
    const gap = g?.gap ?? 0;
    const padding = g?.padding ?? 0;
    if (!mon || !g) {
      return { gap, padding, effGapX: gap, effGapY: gap, coerced: false };
    }
    const eff = effectiveSpacing(mon, { cols: g.cols, rows: g.rows, gap, padding });
    return {
      gap,
      padding,
      effGapX: eff.gapX,
      effGapY: eff.gapY,
      coerced: eff.gapX < gap || eff.gapY < gap,
    };
  }

  /** "8px", or "64px → 41px" when the grid coerces the gap down. */
  function gapLabel(s: SpacingView): string {
    if (!s.coerced) return `${s.gap}px`;
    const eff =
      s.effGapX === s.effGapY ? `${s.effGapX}px` : `${s.effGapX}/${s.effGapY}px`;
    return `${s.gap}px → ${eff}`;
  }

  /** The capped value named in the hint sentence. */
  function cappedGap(s: SpacingView): string {
    return s.effGapX === s.effGapY
      ? `${s.effGapX}px`
      : `${s.effGapX}px across and ${s.effGapY}px down`;
  }

  /** Spacing steppers (spec v0.2 §1) — the brain clamps and re-applies live. */
  function setGridSpacing(grid: GridSettings, gap: number, padding: number): void {
    void emitSettingsSetSpacing({
      gridId: grid.id,
      gap: clamp(gap, 0, MAX_SPACING_PX),
      padding: clamp(padding, 0, MAX_SPACING_PX),
    });
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

  /**
   * What to call a display. `\.\DISPLAY1` is an adapter output, not a
   * monitor: it says nothing about what is plugged in and the numbering
   * shuffles on re-detect. Prefer the name the manufacturer wrote into the
   * EDID, and fall back to the device name when there is none.
   */
  /** Position in the sorted list, 1-based — "Display 1", "Display 2". */
  function displayOrdinalFromId(id: string): string {
    const i = sortedMonitors.findIndex((m) => m.id === id);
    return i >= 0 ? `Display ${i + 1}` : monNameFromId(id);
  }
  /**
   * Turn a vertical wheel into sideways travel on the template strip.
   *
   * The strip only scrolls on one axis, and Chromium is supposed to redirect
   * a vertical wheel into it — measured on the installed build, it does not.
   * Most mice have no horizontal wheel, so without this the only way along
   * the strip is to drag the scrollbar.
   */
  function wheelSideways(e: WheelEvent): void {
    const box = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-strip]');
    if (box === null) return;
    const travel = e.deltaX !== 0 ? e.deltaX : e.deltaY;
    if (travel === 0) return;
    const before = box.scrollLeft;
    box.scrollLeft = before + travel;
    // Only swallow the event if it actually moved something, so a wheel at
    // either end still reaches whatever is underneath.
    if (box.scrollLeft !== before) e.preventDefault();
  }

  function displayOrdinal(m: MonitorInfo): string {
    return displayOrdinalFromId(m.id);
  }

  function monName(m: MonitorInfo): string {
    return m.model?.trim() || monNameFromId(m.id);
  }

  function dpiScale(m: MonitorInfo): number {
    return Math.round((m.dpi / 96) * 100);
  }

  /**
   * Why picking the currently-selected monitor would look like nothing
   * happened: `'empty'`, `'maximized'`, or `null` when it will actually tile.
   */
  const firstRunPickIsIdle = $derived.by(() => {
    if (monitorWindowCounts === null || firstRunPick === null) return null;
    const c = monitorWindowCounts[firstRunPick] ?? { total: 0, tileable: 0 };
    if (c.total === 0) return 'empty';
    if (c.tileable === 0) return 'maximized';
    return null;
  });

  const sortedMonitors = $derived(
    [...monitors].sort((a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x),
  );

  // ── tabs (spec 2026-08-20: minimap pop-out) ──────────────────────────────
  // The window is a small map of your displays, not a scrolling page: one tab
  // per grid, a `+` for spanning/custom grids, and one for preferences. Tabs
  // are derived from live monitors and spanning grids, so a hotplug or a new
  // span reshapes the bar without any stored tab list to go stale.
  interface Tab {
    key: string;
    label: string;
    kind: 'monitor' | 'span' | 'add' | 'prefs';
  }

  const tabs: Tab[] = $derived([
    // Tabs are positions, not products: "Display 1" tells you where you are
    // at a glance and stays the same width whatever is plugged in. The model
    // name is the heading of the panel you land on, where there is room for
    // it and where it answers "which monitor is this?".
    ...sortedMonitors
      // A monitor covered by a spanning grid is configured on the span's own
      // tab; showing both would offer two places to change one thing.
      .filter((m) => !spanFor(m.id))
      .map((m) => ({ key: `mon:${m.id}`, label: displayOrdinal(m), kind: 'monitor' as const })),
    ...spanGrids.map((g) => ({
      key: `span:${g.id}`,
      label: g.monitorIds.map(displayOrdinalFromId).join(' + '),
      kind: 'span' as const,
    })),
    { key: 'add', label: '+', kind: 'add' as const },
    { key: 'prefs', label: '⚙', kind: 'prefs' as const },
  ]);

  let activeTabKey: string | null = $state(null);

  /**
   * The selected tab, falling back to the first (the primary display) —
   * derived rather than stored so a tab that disappears (monitor unplugged,
   * span deleted) can never leave the window blank.
   */
  const activeTab = $derived(
    tabs.find((t) => t.key === activeTabKey) ?? tabs[0] ?? null,
  );

  const isActive = (key: string): boolean => activeTab?.key === key;

  function togglePaused(paused: boolean): void {
    // Rust owns the pause flag; the resulting `paused-changed` round-trips
    // through the brain and lands back here via the snapshot.
    void setPaused(paused);
  }

  function toggleAutostart(enabled: boolean): void {
    autostart = enabled;
    void emitSettingsSetPrefs({ autostart: enabled });
  }

  function toggleSuppressSnap(enabled: boolean): void {
    suppressWindowsSnap = enabled;
    void emitSettingsSetPrefs({ suppressWindowsSnap: enabled });
  }

  function toggleManageSettingsWindow(enabled: boolean): void {
    manageSettingsWindow = enabled;
    void emitSettingsSetPrefs({ manageSettingsWindow: enabled });
  }

  // ── updates (spec §7) ────────────────────────────────────────────────────
  // Same shape as the autostart toggle: local state for the checkbox, one
  // pref event to the brain, which persists it and re-reads it before every
  // automatic check.

  function toggleAutoCheckUpdates(enabled: boolean): void {
    autoCheckUpdates = enabled;
    void emitSettingsSetPrefs({ autoCheckUpdates: enabled });
  }

  /** Relative "last checked" phrasing; the truth is "not this session yet". */
  function lastCheckedLabel(at: number | null): string {
    if (at === null) return 'Not checked yet';
    const mins = Math.floor((Date.now() - at) / 60000);
    if (mins < 1) return 'Checked just now';
    if (mins < 60) return `Checked ${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Checked ${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `Checked ${days} day${days === 1 ? '' : 's'} ago`;
  }

  function formatMB(bytes: number): string {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  /** Honest progress line: exact when the server told us the size, vague when not. */
  const downloadLabel = $derived.by(() => {
    if (update.installing)
      return 'Installing — Griddle Window Manager will restart';
    const fraction = downloadFraction(update);
    if (fraction === null) return `Downloading — ${formatMB(update.downloaded)} so far`;
    return `Downloading — ${formatMB(update.downloaded)} of ${formatMB(
      update.total ?? 0,
    )} (${Math.round(fraction * 100)}%)`;
  });

  const updateBusy = $derived(!canCheckNow(update));

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

  async function refreshMonitorWindowCounts(): Promise<void> {
    try {
      const ws = await listWindows();
      const counts: Record<string, { total: number; tileable: number }> = {};
      for (const w of ws) {
        const c = (counts[w.monitorId] ??= { total: 0, tileable: 0 });
        c.total += 1;
        if (!w.minimized) c.tileable += 1;
      }
      monitorWindowCounts = counts;
    } catch (e) {
      // A failed count is not worth blocking first run over — fall back to
      // showing no hint at all rather than a wrong one.
      console.error('list_windows failed:', e);
      monitorWindowCounts = null;
    }
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

  // ── app defaults (spec v0.2 §2) ──────────────────────────────────────────

  const appRules = $derived.by(() => snapshot?.appRules ?? []);

  /** Grid-specific rules before all-grids ones per exe — precedence order. */
  const sortedAppRules = $derived(
    [...appRules].sort(
      (a, b) =>
        a.exe.localeCompare(b.exe) ||
        Number(a.gridId === null) - Number(b.gridId === null) ||
        (a.gridId ?? '').localeCompare(b.gridId ?? ''),
    ),
  );

  /** Human name of a rule's scope: monitor name, span members, or all grids. */
  function ruleScope(rule: AppRule): string {
    if (rule.gridId === null) return 'All grids';
    if (rule.gridId.startsWith('grid:span:')) {
      const names = rule.gridId
        .slice('grid:span:'.length)
        .split('+')
        .map(monNameFromId)
        .join(' + ');
      return `Spanning: ${names}`;
    }
    if (rule.gridId.startsWith('grid:')) {
      return monNameFromId(rule.gridId.slice('grid:'.length));
    }
    return rule.gridId;
  }

  /** "3×2 · column 4, row 1" — 1-based like people count grid cells. */
  function ruleSlotSummary(rule: AppRule): string {
    const s = rule.slot;
    return `${s.w}×${s.h} · column ${s.col + 1}, row ${s.row + 1}`;
  }

  /**
   * Dims to draw a rule's slot against (critique round): its own grid when
   * the rule names one, else the first enabled grid — an all-grids rule has
   * no single home, so the preview shows where it lands on the grid the user
   * is most likely looking at. Null when no grid is known at all, which
   * simply drops the preview; the text summary stays the accessible truth.
   */
  function ruleDims(rule: AppRule): { cols: number; rows: number } | null {
    const grids = snapshot?.grids ?? [];
    const own =
      rule.gridId !== null ? grids.find((g) => g.id === rule.gridId) : undefined;
    const g = own ?? grids.find((x) => x.enabled) ?? grids[0];
    return g ? { cols: g.cols, rows: g.rows } : null;
  }

  /** Rule slots are stored unbounded and clamp when they fire — do the same. */
  function clampRuleSlot(s: Slot, dims: { cols: number; rows: number }): Slot {
    const w = clamp(s.w, 1, dims.cols);
    const h = clamp(s.h, 1, dims.rows);
    return {
      col: clamp(s.col, 0, dims.cols - w),
      row: clamp(s.row, 0, dims.rows - h),
      w,
      h,
    };
  }

  function removeAppRule(rule: AppRule): void {
    void emitSettingsRemoveAppRule({ exe: rule.exe, gridId: rule.gridId });
  }

  // ── startup views (spec v0.2 §3) ─────────────────────────────────────────

  const views = $derived.by(() => snapshot?.views ?? []);
  const startupViewId = $derived.by(() => snapshot?.startupViewId ?? null);
  const anyGridEnabled = $derived.by(
    (): boolean => snapshot?.grids.some((g) => g.enabled) ?? false,
  );

  let viewNameDraft = $state('');
  /** View currently in inline rename, if any. */
  let renamingViewId: string | null = $state(null);
  let renameDraft = $state('');

  const viewNameValid = $derived(viewNameDraft.trim() !== '');

  function captureCurrentView(): void {
    const name = viewNameDraft.trim();
    if (name === '' || !anyGridEnabled) return;
    void emitSettingsCaptureView({ name });
    viewNameDraft = '';
  }

  function applyViewNow(viewId: string): void {
    void emitSettingsApplyView({ viewId });
  }

  function startRename(view: View): void {
    renamingViewId = view.id;
    renameDraft = view.name;
  }

  function commitRename(): void {
    if (renamingViewId === null) return;
    const name = renameDraft.trim();
    const current = views.find((v) => v.id === renamingViewId);
    if (name !== '' && current && name !== current.name) {
      void emitSettingsRenameView({ viewId: renamingViewId, name });
    }
    renamingViewId = null;
  }

  function deleteView(viewId: string): void {
    if (renamingViewId === viewId) renamingViewId = null;
    void emitSettingsDeleteView({ viewId });
  }

  /**
   * Two-step armed delete (critique round), the same guard TemplateGallery
   * uses — a view is the richer object (every grid, its spacing, every app
   * assignment, possibly the startup selection) and there is no undo, so it
   * cannot be weaker than a template's. WebView2 dialogs are disabled, hence
   * arm-and-confirm rather than a native confirm.
   */
  let armedDeleteViewId: string | null = $state(null);
  let viewDisarmTimer: ReturnType<typeof setTimeout> | null = null;

  function requestDeleteView(view: View): void {
    if (viewDisarmTimer !== null) clearTimeout(viewDisarmTimer);
    viewDisarmTimer = null;
    if (armedDeleteViewId === view.id) {
      armedDeleteViewId = null;
      deleteView(view.id);
      return;
    }
    armedDeleteViewId = view.id;
    viewDisarmTimer = setTimeout(() => {
      armedDeleteViewId = null;
      viewDisarmTimer = null;
    }, 2500);
  }

  function setStartupView(viewId: string | null): void {
    void emitSettingsSetStartupView({ viewId });
  }

  /** "2 grids · 5 windows" — what applying this view brings back. */
  function viewSummary(view: View): string {
    const grids = view.grids.length;
    const wins = view.grids.reduce((n, g) => n + g.assignments.length, 0);
    return `${grids} ${grids === 1 ? 'grid' : 'grids'} · ${wins} ${
      wins === 1 ? 'window' : 'windows'
    }`;
  }

  /** Focus + select the inline rename input the moment it appears. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  // ── first run (plan Task 19) ─────────────────────────────────────────────

  function enableFirstRun(): void {
    if (firstRunPick === null) return;
    if (firstRunAutostart) {
      // Same path as the General toggle — the brain persists it with the
      // grid it is about to enable, so one config write captures both.
      autostart = true;
      void emitSettingsSetPrefs({ autostart: true });
    }
    if (firstRunSuppressSnap) {
      suppressWindowsSnap = true;
      void emitSettingsSetPrefs({ suppressWindowsSnap: true });
    }
    void emitSettingsEnableGrid({
      monitorId: firstRunPick,
      cols: DEFAULT_DIMS.cols,
      rows: DEFAULT_DIMS.rows,
    });
  }
</script>

<!--
  The mark: a capital G built out of grid cells, on a 150-unit master
  (4x4 grid, cell 33, gap 6). Convex corners 8, concave 4; the counter is
  outer 12 / stroke 8 / inner 4. Drawn at 28px here, where the 1.5px stroke
  holds — below 32px the counter has to go solid instead.
  Source of truth: apps/desktop/app-icon.svg.
-->
{#snippet minusIcon()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"
    ><path d="M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg
  >
{/snippet}

{#snippet plusIcon()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"
    ><path
      d="M8 3v10M3 8h10"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    /></svg
  >
{/snippet}

{#snippet tick()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"
    ><path
      d="M3.5 8.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    /></svg
  >
{/snippet}

{#snippet squares()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"
    ><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.4" /><rect
      x="9"
      y="1.5"
      width="5.5"
      height="5.5"
      rx="1.4"
    /><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.4" /><rect
      x="9"
      y="9"
      width="5.5"
      height="5.5"
      rx="1.4"
    /></svg
  >
{/snippet}

{#snippet collapseIcon()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
    ><path d="M9.5 6.5h4M9.5 6.5v-4M9.5 6.5L14 2M6.5 9.5h-4M6.5 9.5v4M6.5 9.5L2 14" /></svg
  >
{/snippet}

{#snippet gearIcon()}
  <!-- A solid cog rather than a circle with spokes: at 15px the spoked version
       reads as a sunburst, which is not what a settings control should say. -->
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"
    ><path
      d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42H10.6a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L3.22 8.87a.5.5 0 0 0 .12.61l2 1.58a7.07 7.07 0 0 0 0 1.88l-2 1.58a.5.5 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .59.22l2.39-.96a7.03 7.03 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.03 7.03 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61ZM12 15.6A3.6 3.6 0 1 1 15.6 12 3.6 3.6 0 0 1 12 15.6Z"
    /></svg
  >
{/snippet}

{#snippet sunIcon()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
    ><circle cx="8" cy="8" r="3.1" /><path
      d="M8 1.2v1.5M8 13.3v1.5M14.8 8h-1.5M2.7 8H1.2M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1M12.8 12.8l-1.1-1.1M4.3 4.3L3.2 3.2"
    /></svg
  >
{/snippet}

{#snippet moonIcon()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"
    ><path d="M13.3 10.1A5.7 5.7 0 0 1 6 2.7a5.9 5.9 0 1 0 7.3 7.4Z" /></svg
  >
{/snippet}

{#snippet pauseIcon()}
  <svg class="ico" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"
    ><rect x="3.5" y="2.5" width="3.4" height="11" rx="1.1" /><rect
      x="9.1"
      y="2.5"
      width="3.4"
      height="11"
      rx="1.1"
    /></svg
  >
{/snippet}

<!-- One band of the settings table: a label cell that carries the vertical
     rule, then the minus / value / plus cells pinned to the right edge. -->
{#snippet stepper(
  label: string,
  unit: string | null,
  value: number,
  min: number,
  max: number,
  step: number,
  disabled: boolean,
  commit: (v: number) => void,
)}
  <div class="row" class:dimmed={disabled}>
    <div class="cell label">
      <span class="lbl">{label}</span>
      {#if unit}<span class="unit">({unit})</span>{/if}
    </div>
    <button
      class="cell step"
      aria-label={`Decrease ${label}`}
      disabled={disabled || value <= min}
      onclick={() => commit(value - step)}
      use:holdRepeat={() => commit(value - step)}>{@render minusIcon()}</button
    >
    <div class="cell num">
      <NumberField {value} {min} {max} {label} {disabled} onCommit={commit} />
    </div>
    <button
      class="cell step"
      aria-label={`Increase ${label}`}
      disabled={disabled || value >= max}
      onclick={() => commit(value + step)}
      use:holdRepeat={() => commit(value + step)}>{@render plusIcon()}</button
    >
  </div>
{/snippet}

{#snippet brandMark()}
  <svg class="brandmark" viewBox="0 0 150 150" fill="none" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8 0H103A8 8 0 0 1 111 8V25A8 8 0 0 1 103 33H37A4 4 0 0 0 33 37V113A4 4 0 0 0 37 117H64A8 8 0 0 1 72 125V142A8 8 0 0 1 64 150H8A8 8 0 0 1 0 142V8A8 8 0 0 1 8 0Z"
    />
    <rect
      x="82"
      y="82"
      width="64"
      height="64"
      rx="8"
      stroke="currentColor"
      stroke-width="8"
    />
  </svg>
{/snippet}

<!-- Esc dismisses the pop-out. With no title bar there is no X, and the
     window is not in the taskbar either, so the keyboard needs the same one
     press out that the chevron gives the mouse. Guarded on the first run,
     where the welcome screen is a step to finish rather than a panel to
     flick away, and on text fields, where Esc means "cancel this edit". -->
<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape' || firstRun) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    void hideSettings();
  }}
/>

<!-- The whole panel is a drag surface, not just the brand row: this is a
     minimap you reposition, and a frameless window with one thin grab strip
     is worse to move than a titled one. Tauri tests the event target, so the
     attribute lives on the containers and every control inside them stays
     clickable by virtue of being the target itself. -->
<div class="page" data-tauri-drag-region>
  {#if firstRun}
    <header>
      <div class="brand">
        {@render brandMark()}
        <div>
          <h1>Griddle Window Manager</h1>
          <p class="tagline">
            Window grids for your desktop{#if appVersion}
              <span class="version">{appVersion}</span>{/if}
          </p>
        </div>
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
              {#if monitorWindowCounts !== null}
                {@const c = monitorWindowCounts[mon.id] ?? { total: 0, tileable: 0 }}
                <span class="fr-mon-windows" class:empty={c.tileable === 0}>
                  {#if c.total === 0}
                    no windows here yet
                  {:else if c.tileable === 0}
                    {c.total}
                    {c.total === 1 ? 'window' : 'windows'}, all maximized
                  {:else}
                    {c.tileable}
                    {c.tileable === 1 ? 'window' : 'windows'} ready to tile
                  {/if}
                </span>
              {/if}
            </label>
          {/each}
        </div>
      {/if}

      <label class="pick">
        <input type="checkbox" bind:checked={firstRunAutostart} />
        <span>Start with Windows — keep your grids working after a reboot</span>
      </label>

      <!-- Opt-in, unchecked (spec 2026-08-19): changing a Windows setting is
           the user's call, and the copy promises the undo. -->
      <label class="pick">
        <input type="checkbox" bind:checked={firstRunSuppressSnap} />
        <span>
          Turn off Windows edge-snap while Griddle runs — stops Windows' own
          drag-to-edge snap from fighting the grid. Griddle puts it back when
          it quits.
        </span>
      </label>

      <div class="controls">
        <button
          class="primary"
          disabled={firstRunPick === null}
          onclick={enableFirstRun}>Enable grid</button
        >
        <span class="hint">
          {#if firstRunPickIsIdle === 'empty'}
            Starts as a 12×6 grid. There are no windows on this monitor yet, so
            it will look empty until you move one over — that is expected, not a
            failure.
          {:else if firstRunPickIsIdle === 'maximized'}
            Starts as a 12×6 grid. Every window on this monitor is maximized and
            a grid leaves maximized windows alone, so nothing will move until
            you restore one.
          {:else}
            Starts as a 12×6 grid — your windows on this monitor snap into
            place right away, and you can change everything later.
          {/if}
        </span>
        <!-- Honest label: this page never returns (the first config write
             ends first-run for good) — skipping simply lands on the full
             settings page, where every enable toggle lives. -->
        <button class="quiet" onclick={() => (firstRun = false)}>
          Skip to Settings
        </button>
      </div>
      <p class="hint">
        Griddle Window Manager lives in the system tray — closing this window
        keeps your grids running.
      </p>
    </section>
  {:else}
  <!-- Compact in the pop-out (spec 2026-08-20, stage 3): the brand row keeps
       the mark and the version and gives the rest of its height to the map.
       It is also the *only* way to move the window — the pop-out is
       undecorated, so this row stands in for the title bar and carries
       `data-tauri-drag-region`. The attribute has to be on each element the
       pointer can actually land on: Tauri tests the event target, not its
       ancestors, so a bare child would be a dead patch in the drag handle.
       The pause switch deliberately lacks it — dragging off a toggle would
       eat the click. -->
  <!-- Sticky top bar (field report 2026-08-20): the pop-out scrolls, and
       a header that scrolls with it let content slide up alongside the
       tabs. Brand row and tabs ride together at the top and the sections
       pass underneath; the negative margins cancel the page padding so
       the bar spans edge to edge and actually occludes what it covers. -->
  <div class="topbar">
    <!-- Brand band (Figma 110-344): mark, name, version, and Pause as a
         labelled action rather than a switch — it is the panic button, so it
         reads as something you press, not a preference you set. -->
    <div class="row brandrow" data-tauri-drag-region>
      <div class="cell label nodivide" data-tauri-drag-region>
        {@render brandMark()}
        <span class="wordmark" data-tauri-drag-region>Griddle</span>
        <span class="product" data-tauri-drag-region>Window Manager</span>
        {#if appVersion}<span class="version" data-tauri-drag-region>{appVersion}</span>{/if}
      </div>
      <button
        class="cell icon"
        title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        aria-label={theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance'}
        aria-pressed={theme === 'light'}
        onclick={toggleTheme}
      >
        {#if theme === 'dark'}{@render sunIcon()}{:else}{@render moonIcon()}{/if}
      </button>
      <button
        class="cell icon"
        class:sel={isActive('prefs')}
        aria-pressed={isActive('prefs')}
        title="Preferences"
        onclick={() => (activeTabKey = 'prefs')}
      >
        {@render gearIcon()}
      </button>
      <button class="cell icon" title="Hide to tray" onclick={() => void hideSettings()}>
        {@render collapseIcon()}
      </button>
      <!-- Pause is last on purpose: the icon buttons group together, and the
           one labelled control — the panic button — ends the row where the
           eye stops. -->
      <button
        class="cell wide ghost pause"
        class:on={snapshot?.paused}
        aria-pressed={snapshot?.paused ?? false}
        title="Suspend tracking and placement everywhere"
        onclick={() => togglePaused(!(snapshot?.paused ?? false))}
      >
        <span>{snapshot?.paused ? 'Paused' : 'Pause'}</span>
        {@render pauseIcon()}
      </button>
    </div>

    <!-- Tab band: one segment per grid plus `+`, each divided by a rule, then
         the two window actions pinned right. The gear selects the preferences
         tab like any other, but reads as an action because that is what it is
         next to — it is not a display. -->
    {#if tabs.length > 0}
      <nav class="row tabrow" aria-label="Displays and settings" data-tauri-drag-region>
        <div class="tabs" role="tablist">
          {#each tabs.filter((t) => t.kind !== 'prefs') as t (t.key)}
            <button
              role="tab"
              class="tab"
              class:sel={isActive(t.key)}
              class:glyph={t.kind === 'add'}
              aria-selected={isActive(t.key)}
              title={t.kind === 'add' ? 'Add a spanning or custom grid' : t.label}
              onclick={() => (activeTabKey = t.key)}
            >
              {t.label}
            </button>
          {/each}
        </div>
        <div class="spacer" data-tauri-drag-region></div>
      </nav>
    {/if}
  </div>

  <!-- Update banner (spec §7). Nothing here happens on its own: the release
       is named, its notes are shown in full, and the install only starts when
       the user presses the button. -->
  {#if update.phase === 'available' && update.version}
    <section class="card update-banner">
      <div class="card-head">
        <div class="mon-info">
          <h2>Griddle Window Manager {update.version} is available</h2>
          <p class="meta">
            You are on {appVersion || 'this release'}{#if update.date} ·
              released {update.date}{/if}
          </p>
        </div>
      </div>
      {#if update.notes}
        <div class="release-notes">{update.notes}</div>
      {:else}
        <p class="hint">
          This release ships no notes — the version number above is all the
          feed carries.
        </p>
      {/if}
      <div class="controls">
        <button class="primary" onclick={() => void emitSettingsInstallUpdate()}>
          Download and install
        </button>
        <button class="quiet" onclick={() => void emitSettingsDismissUpdate()}>
          Not now
        </button>
      </div>
      <p class="hint">
        Griddle Window Manager downloads the installer from GitHub, checks its
        signature, pauses window management, saves your settings, and restarts.
        Your grids come back exactly as they are now.
      </p>
    </section>
  {:else if update.phase === 'downloading'}
    {@const fraction = downloadFraction(update)}
    <section class="card update-banner">
      <div class="card-head">
        <div class="mon-info">
          <h2>Getting Griddle Window Manager {update.version}</h2>
          <p class="meta">{downloadLabel}</p>
        </div>
      </div>
      <div
        class="progress"
        class:indeterminate={fraction === null}
        role="progressbar"
        aria-label="Update download"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      >
        <span class="bar" style={fraction === null ? '' : `width: ${fraction * 100}%`}
        ></span>
      </div>
      <p class="hint">
        Window management is released the moment the installer takes over —
        your windows stay where they are until Griddle Window Manager comes
        back.
      </p>
    </section>
  {:else if update.phase === 'error'}
    <section class="card update-banner failed">
      <div class="card-head">
        <div class="mon-info">
          <h2>The update didn't go through</h2>
          <p class="meta">{update.error}</p>
        </div>
      </div>
      <div class="controls">
        <button
          class="primary"
          disabled={updateBusy}
          onclick={() => void emitSettingsCheckUpdates()}>Try again</button
        >
        <button class="quiet" onclick={() => void emitSettingsDismissUpdate()}>
          Dismiss
        </button>
      </div>
      <p class="hint">
        Nothing was changed. You can also download the installer yourself from
        the releases page.
      </p>
    </section>
  {/if}

  {#if sortedMonitors.length === 0}
    <p class="empty">Looking for monitors…</p>
  {/if}


  {#each sortedMonitors.filter((m) => isActive(`mon:${m.id}`)) as mon (mon.id)}
    {@const grid = gridFor(mon.id)}
    {@const spanned = spanFor(mon.id)}
    {@const enabled = grid?.enabled ?? false}
    {@const dims = dimsFor(mon)}
    {@const spacing = spacingView(mon, grid)}
    {@const tiles = (grid && snapshot?.tiles[grid.id]) || []}
    <!-- Structure per the Figma spec (node 110-344): the panel is a table of
         full-width bands, each 32px tall with a hairline under it, and every
         control sits in its own 32px cell against the right edge. The label
         cell carries the vertical rule, so the controls line up in a column
         down the whole widget regardless of how long the labels are. -->
    <section class="rows fill" data-tauri-drag-region>
      <div class="row" data-tauri-drag-region>
        <div class="cell label" data-tauri-drag-region>
          <span class="mon-name">{monName(mon)}</span>
          <span class="meta-inline">{mon.width}×{mon.height}</span>
          {#if spanned}<span class="badge">Spanned</span>{/if}
        </div>
        <label class="cell wide check" title={spanned ? 'Part of a spanning grid' : 'Apply the grid to this display'}>
          <span class="check-label">Grid on</span>
          <input
            type="checkbox"
            checked={enabled}
            disabled={spanned !== undefined}
            onchange={(e) => toggleGrid(mon, e.currentTarget.checked)}
          />
          <span class="box" aria-hidden="true">{@render tick()}</span>
        </label>
      </div>

      {#if spanned}
        <p class="rowhint">
          This monitor is part of a spanning grid — disable that grid to manage
          it on its own.
        </p>
      {/if}

      {#if spanned === undefined}
        <!-- One block, not four bands: the dimension controls belong together,
             so the rules go around the group rather than between its rows.
             Grid behavior stays outside it and last (Figma 112-117): it has
             its own rules there, and it governs what the numbers do. -->
        <div class="group">
        {@render stepper('Columns', null, dims.cols, 1, MAX_COLS, 1, !enabled, (v) => setDims(mon, v, dims.rows))}
        {@render stepper('Rows', null, dims.rows, 1, MAX_ROWS, 1, !enabled, (v) => setDims(mon, dims.cols, v))}
        {@render stepper('Gap', 'px', spacing.gap, 0, MAX_SPACING_PX, SPACING_STEP, !enabled || !grid, (v) => grid && setGridSpacing(grid, v, spacing.padding))}
        {@render stepper('Padding', 'px', spacing.padding, 0, MAX_SPACING_PX, SPACING_STEP, !enabled || !grid, (v) => grid && setGridSpacing(grid, spacing.gap, v))}
        </div>

        {#if enabled && grid}
          <div class="row">
            <div class="cell label"><span class="lbl">Grid behavior</span></div>
            <div class="cell behavior">
              <PlacementPicker
                value={grid.mode}
                options={PLACEMENT_MODES}
                compact
                onchange={(v) => setMode(grid, v as PlacementMode)}
              />
            </div>
          </div>
        {/if}
      {/if}

      {#if !spanned && spacing.coerced}
        <p class="rowhint">
          This grid's cells are too small for a {spacing.gap}px gap, so it is
          capped at {cappedGap(spacing)} — the editor and your desktop both
          show the capped value.
        </p>
      {/if}

      {#if enabled && grid}
        <div class="row" data-tauri-drag-region>
          <div class="cell label" data-tauri-drag-region>
            <span class="lbl">Live grid manager</span>
            <span class="meta-inline">drag and resize from here</span>
          </div>
          <button
            class="cell wide ghost"
            aria-expanded={templatesOpen}
            title="Saved slot arrangements you can apply to this grid"
            onclick={() => (templatesOpen = !templatesOpen)}
          >
            <span>Templates</span>
            {@render squares()}
          </button>
        </div>

        <!-- Templates take the map's place rather than pushing it down: the
             editor stays mounted but hidden, so the band keeps exactly the
             height it had and nothing below it moves. The gallery then scrolls
             sideways inside that fixed box. -->
        <div
          class="mapband"
          data-tauri-drag-region
          bind:clientWidth={mapW}
          bind:clientHeight={mapH}
        >
          <div class="mapstack" class:swapped={templatesOpen}>
            <div class="mapinner" inert={templatesOpen}>
              {#key `${grid.id}:${grid.cols}x${grid.rows}:${grid.mode}:${grid.gap ?? 0}:${grid.padding ?? 0}:${mapW}x${mapH}`}
                <GridEditor
                  gridId={grid.id}
                  cols={grid.cols}
                  rows={grid.rows}
                  mode={grid.mode}
                  monitor={mon}
                  gap={grid.gap ?? 0}
                  padding={grid.padding ?? 0}
                  width={mapW}
                  height={mapH}
                  {tiles}
                  {appRules}
                />
              {/key}
            </div>
            {#if templatesOpen}
              <div class="carousel" onwheel={wheelSideways}>
                <TemplateGallery
                  gridId={grid.id}
                  templates={snapshot?.templates ?? []}
                  activeTemplateId={grid.activeTemplateId}
                  tileCount={tiles.length}
                  gridCols={grid.cols}
                  gridRows={grid.rows}
                  carousel
                />
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  {/each}

  {#each spanGrids.filter((g) => isActive(`span:${g.id}`)) as grid (grid.id)}
    {@const members = spanMonitors(grid)}
    {@const union =
      members.length === grid.monitorIds.length ? unionWorkArea(members) : null}
    {@const spacing = spacingView(union, grid)}
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
        <label class="switch row">
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
            onclick={() => setSpanDims(grid, grid.cols - 1, grid.rows)}
            use:holdRepeat={() => setSpanDims(grid, grid.cols - 1, grid.rows)}>−</button
          >
          <NumberField
            value={grid.cols}
            min={1}
            max={MAX_COLS}
            label="Columns"
            onCommit={(v) => setSpanDims(grid, v, grid.rows)}
          />
          <button
            aria-label="More columns"
            disabled={grid.cols >= MAX_COLS}
            onclick={() => setSpanDims(grid, grid.cols + 1, grid.rows)}
            use:holdRepeat={() => setSpanDims(grid, grid.cols + 1, grid.rows)}>+</button
          >
        </div>
        <div class="stepper">
          <span class="lbl">Rows</span>
          <button
            aria-label="Fewer rows"
            disabled={grid.rows <= 1}
            onclick={() => setSpanDims(grid, grid.cols, grid.rows - 1)}
            use:holdRepeat={() => setSpanDims(grid, grid.cols, grid.rows - 1)}>−</button
          >
          <NumberField
            value={grid.rows}
            min={1}
            max={MAX_ROWS}
            label="Rows"
            onCommit={(v) => setSpanDims(grid, grid.cols, v)}
          />
          <button
            aria-label="More rows"
            disabled={grid.rows >= MAX_ROWS}
            onclick={() => setSpanDims(grid, grid.cols, grid.rows + 1)}
            use:holdRepeat={() => setSpanDims(grid, grid.cols, grid.rows + 1)}>+</button
          >
        </div>
        <PlacementPicker
          value={grid.mode}
          options={PLACEMENT_MODES}
          onchange={(v) => setMode(grid, v as PlacementMode)}
        />
        <span class="tile-count">
          {tiles.length}
          {tiles.length === 1 ? 'window' : 'windows'}
        </span>
      </div>
      <!-- Spacing steppers (spec v0.2 §1), same semantics as monitor cards;
           padding insets the union work area. -->
      <div class="controls">
        <div class="stepper">
          <span class="lbl" title="Space between neighboring windows">Gap</span>
          <button
            aria-label="Smaller gap"
            disabled={(grid.gap ?? 0) <= 0}
            onclick={() =>
              setGridSpacing(grid, (grid.gap ?? 0) - SPACING_STEP, grid.padding ?? 0)}
            use:holdRepeat={() =>
              setGridSpacing(grid, (grid.gap ?? 0) - SPACING_STEP, grid.padding ?? 0)}
            >−</button
          >
          <NumberField
            value={spacing.gap}
            min={0}
            max={MAX_SPACING_PX}
            label="Gap in pixels"
            suffix="px"
            disabled={false}
            onCommit={(v) => setGridSpacing(grid, v, grid.padding ?? 0)}
          />
          {#if spacing.coerced}
            <span
              class="coerced-note"
              title={`Capped at ${cappedGap(spacing)} — this grid's cells are too small for ${spacing.gap}px`}
              >→ {cappedGap(spacing)}</span
            >
          {/if}
          <button
            aria-label="Larger gap"
            disabled={(grid.gap ?? 0) >= MAX_SPACING_PX}
            onclick={() =>
              setGridSpacing(grid, (grid.gap ?? 0) + SPACING_STEP, grid.padding ?? 0)}
            use:holdRepeat={() =>
              setGridSpacing(grid, (grid.gap ?? 0) + SPACING_STEP, grid.padding ?? 0)}
            >+</button
          >
        </div>
        <div class="stepper">
          <span class="lbl" title="Margin between the grid and the union work-area edges">
            Padding
          </span>
          <button
            aria-label="Less padding"
            disabled={(grid.padding ?? 0) <= 0}
            onclick={() =>
              setGridSpacing(grid, grid.gap ?? 0, (grid.padding ?? 0) - SPACING_STEP)}
            use:holdRepeat={() =>
              setGridSpacing(grid, grid.gap ?? 0, (grid.padding ?? 0) - SPACING_STEP)}
            >−</button
          >
          <NumberField
            value={grid.padding ?? 0}
            min={0}
            max={MAX_SPACING_PX}
            label="Padding in pixels"
            suffix="px"
            onCommit={(v) => setGridSpacing(grid, grid.gap ?? 0, v)}
          />
          <button
            aria-label="More padding"
            disabled={(grid.padding ?? 0) >= MAX_SPACING_PX}
            onclick={() =>
              setGridSpacing(grid, grid.gap ?? 0, (grid.padding ?? 0) + SPACING_STEP)}
            use:holdRepeat={() =>
              setGridSpacing(grid, grid.gap ?? 0, (grid.padding ?? 0) + SPACING_STEP)}
            >+</button
          >
        </div>
      </div>
      <p class="hint">
        Gap spaces neighboring windows apart; padding insets the whole grid
        from the union work-area edges.{#if spacing.coerced}
          This grid's cells are too small for a {spacing.gap}px gap, so it is
          capped at {cappedGap(spacing)} — the editor below and your desktop
          both show the capped value.{/if}
      </p>
      <p class="hint">{modeHint(grid.mode)}</p>

      {#if union}
        {#key `${grid.id}:${grid.cols}x${grid.rows}:${grid.mode}:${grid.gap ?? 0}:${grid.padding ?? 0}`}
          <GridEditor
            gridId={grid.id}
            cols={grid.cols}
            rows={grid.rows}
            mode={grid.mode}
            monitor={union}
            gap={grid.gap ?? 0}
            padding={grid.padding ?? 0}
            {tiles}
            {appRules}
          />
        {/key}
        <p class="hint">
          Drag tiles to rearrange the real windows — right-click one to make
          its spot the default for that app. Cells over the gap of an
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

  {#if isActive('add') && sortedMonitors.length >= 2}
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
            use:holdRepeat={() => (spanDraft.cols = clamp(spanDraft.cols - 1, 1, MAX_COLS))}
            >−</button
          >
          <NumberField
            value={spanDraft.cols}
            min={1}
            max={MAX_COLS}
            label="Columns"
            onCommit={(v) => (spanDraft = { ...spanDraft, cols: v })}
          />
          <button
            aria-label="More columns"
            disabled={spanDraft.cols >= MAX_COLS}
            onclick={() => (spanDraft.cols = clamp(spanDraft.cols + 1, 1, MAX_COLS))}
            use:holdRepeat={() => (spanDraft.cols = clamp(spanDraft.cols + 1, 1, MAX_COLS))}
            >+</button
          >
        </div>
        <div class="stepper">
          <span class="lbl">Rows</span>
          <button
            aria-label="Fewer rows"
            disabled={spanDraft.rows <= 1}
            onclick={() => (spanDraft.rows = clamp(spanDraft.rows - 1, 1, MAX_ROWS))}
            use:holdRepeat={() => (spanDraft.rows = clamp(spanDraft.rows - 1, 1, MAX_ROWS))}
            >−</button
          >
          <NumberField
            value={spanDraft.rows}
            min={1}
            max={MAX_ROWS}
            label="Rows"
            onCommit={(v) => (spanDraft = { ...spanDraft, rows: v })}
          />
          <button
            aria-label="More rows"
            disabled={spanDraft.rows >= MAX_ROWS}
            onclick={() => (spanDraft.rows = clamp(spanDraft.rows + 1, 1, MAX_ROWS))}
            use:holdRepeat={() => (spanDraft.rows = clamp(spanDraft.rows + 1, 1, MAX_ROWS))}
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
        Spanning has had the least real-world testing of anything here —
        please report anything odd.
      </p>
    </section>
  {/if}

  {#if isActive('prefs')}
  <!-- App defaults (spec v0.2 §2): the rules the tile context menu saves. -->
  <section class="card">
    <div class="card-head">
      <div class="mon-info">
        <h2>App defaults</h2>
        <p class="meta">Where new windows of these programs are placed.</p>
      </div>
    </div>
    {#if sortedAppRules.length > 0}
      <ul class="rule-list">
        {#each sortedAppRules as rule (`${rule.exe}\0${rule.gridId ?? ''}`)}
          {@const dims = ruleDims(rule)}
          <li class="rule-row">
            <!-- Coordinates alone make people map "column 4, row 1" onto
                 their grid in their head; the miniature (same idea as the
                 template previews) shows the spot. The text stays the
                 accessible label — the drawing is decorative. -->
            {#if dims}
              {@const s = clampRuleSlot(rule.slot, dims)}
              <svg
                class="rule-preview"
                viewBox="0 0 {dims.cols} {dims.rows}"
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
              >
                <rect
                  class="frame"
                  x="0.05"
                  y="0.05"
                  width={dims.cols - 0.1}
                  height={dims.rows - 0.1}
                  rx="0.3"
                />
                <rect
                  class="slot"
                  x={s.col + 0.1}
                  y={s.row + 0.1}
                  width={Math.max(s.w - 0.2, 0.1)}
                  height={Math.max(s.h - 0.2, 0.1)}
                  rx="0.25"
                />
              </svg>
            {/if}
            <code class="rule-exe">{rule.exe}</code>
            <span class="rule-scope" class:all={rule.gridId === null}>
              {ruleScope(rule)}
            </span>
            <span class="rule-slot">{ruleSlotSummary(rule)}</span>
            <button
              class="chip-x"
              aria-label={`Remove default for ${rule.exe} (${ruleScope(rule)})`}
              title="Remove this default"
              onclick={() => removeAppRule(rule)}>×</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <p class="hint">
        No defaults yet — right-click a window tile in a grid editor above and
        choose “Save for this grid”.
      </p>
    {/if}
    <p class="hint">
      A default places every new window of that program into the saved cells.
      A rule for a specific grid beats an all-grids rule; windows already on
      screen never move when a default is saved or removed.
    </p>
  </section>

  <!-- Views (spec v0.2 §3): whole-desktop snapshots + load-at-startup. -->
  <section class="card">
    <div class="card-head">
      <div class="mon-info">
        <h2>Views</h2>
        <p class="meta">Snapshots of your grids and which app sits where.</p>
      </div>
    </div>
    {#if views.length > 0}
      <ul class="view-list">
        {#each views as view (view.id)}
          <li class="view-row">
            {#if renamingViewId === view.id}
              <input
                class="view-rename"
                type="text"
                bind:value={renameDraft}
                spellcheck="false"
                aria-label={`New name for view ${view.name}`}
                use:focusOnMount
                onkeydown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') renamingViewId = null;
                }}
                onblur={commitRename}
              />
            {:else}
              <span class="view-name">{view.name}</span>
            {/if}
            <span class="view-summary">{viewSummary(view)}</span>
            <div class="view-actions">
              <button
                class="quiet small"
                title="Rebuild these grids and move every already-running saved app back to its place — this does not launch anything"
                onclick={() => applyViewNow(view.id)}>Apply now</button
              >
              <button
                class="quiet small"
                onclick={() => startRename(view)}>Rename</button
              >
              <!-- Armed two-step, matching the template gallery: a view
                   carries every grid, its spacing, every app assignment and
                   possibly the startup choice, and there is no undo. -->
              <button
                class="quiet small danger"
                class:armed={armedDeleteViewId === view.id}
                aria-label={armedDeleteViewId === view.id
                  ? `Confirm deleting view ${view.name}`
                  : `Delete view ${view.name}`}
                onclick={() => requestDeleteView(view)}
              >
                {armedDeleteViewId === view.id ? 'Sure?' : 'Delete'}
              </button>
            </div>
          </li>
        {/each}
      </ul>
      <div
        class="controls startup-pick"
        role="radiogroup"
        aria-label="View to load at startup"
      >
        <span class="lbl">Load at startup</span>
        <label class="pick">
          <input
            type="radio"
            name="startup-view"
            checked={startupViewId === null}
            onchange={() => setStartupView(null)}
          />
          <span>None</span>
        </label>
        {#each views as view (view.id)}
          <label class="pick">
            <input
              type="radio"
              name="startup-view"
              checked={startupViewId === view.id}
              onchange={() => setStartupView(view.id)}
            />
            <span>{view.name}</span>
          </label>
        {/each}
      </div>
    {:else}
      <p class="hint">
        No views yet — arrange your windows the way you like, then capture the
        whole arrangement here.
      </p>
    {/if}
    <div class="controls">
      <label class="field">
        <span class="lbl">Name</span>
        <input
          class="view-input"
          type="text"
          placeholder="e.g. Deep work"
          bind:value={viewNameDraft}
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === 'Enter') captureCurrentView();
          }}
        />
      </label>
      <button
        class="primary"
        disabled={!viewNameValid || !anyGridEnabled}
        onclick={captureCurrentView}>Capture view</button
      >
    </div>
    {#if !anyGridEnabled}
      <p class="hint">
        Enable a grid first — a view saves your enabled grids and the windows
        on them.
      </p>
    {/if}
    <!-- Three things this card has to say plainly (critique round):
         what a view is *versus* a template, that applying one places windows
         but never starts programs, and that during the claim window a view
         outranks the app defaults card above. -->
    <p class="hint">
      A template saves a slot arrangement for one grid; a view saves every
      grid — dimensions, spacing — and remembers which program goes where.
    </p>
    <p class="hint">
      Applying a view rebuilds its grids and puts each program's windows back
      on their saved cells. It does not launch programs: apps already running,
      or started within the next two minutes, land on their saved spots —
      taking priority over app defaults during that window. With a startup
      view, that covers the apps Windows relaunches after a reboot.
    </p>
  </section>

  <!-- General and Excluded apps sit below the placement cards (critique
       round, v0.2): App defaults and Views are what users come back to, and
       they belong next to the grid editors that feed them. Within this pair
       General still comes first (critique round 3) — universal settings
       above an edge-case tool. -->
  <section class="card">
    <div class="card-head">
      <div class="mon-info">
        <h2>General</h2>
        <!-- Not "Startup": the startup *layout* lives in Views, and this
             card must not claim to be its home. -->
        <p class="meta">Launch at sign-in and the settings hotkey.</p>
      </div>
    </div>
    <div class="controls">
      <label class="switch row">
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
      <label class="switch row">
        <input
          type="checkbox"
          checked={suppressWindowsSnap}
          onchange={(e) => toggleSuppressSnap(e.currentTarget.checked)}
        />
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label wide">Turn off Windows edge-snap while Griddle runs</span>
      </label>
    </div>
    <p class="hint">
      Stops Windows' own drag-to-edge snap and the Snap Layouts flyout from
      fighting the grid. Win+Arrow keeps working. Griddle restores your
      Windows settings when it quits.
    </p>
    <div class="controls">
      <label class="switch row">
        <input
          type="checkbox"
          checked={manageSettingsWindow}
          onchange={(e) => toggleManageSettingsWindow(e.currentTarget.checked)}
        />
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label wide">Snap this Griddle window to the grid</span>
      </label>
    </div>
    <p class="hint">
      Off by default, because this window is a map of your grid — snapping it
      in makes it occupy one of the cells it is describing. Leave it off and
      drag it anywhere; Griddle remembers where you put it.
    </p>
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
    <p class="hint">
      Looking for what your desktop looks like after a restart? That's “Load
      at startup” in the Views card above.
    </p>
  </section>

  <!-- Updates (spec §7). This is the only card in the app that can cause
       network traffic, so it says so plainly and starts switched off. -->
  <section class="card">
    <div class="card-head">
      <div class="mon-info">
        <h2>Updates</h2>
        <p class="meta">
          You are running {appVersion || 'this release'}{#if autoCheckUpdates}
            · {lastCheckedLabel(update.lastCheckedAt)}{/if}
        </p>
      </div>
    </div>
    <div class="controls">
      <label class="switch row">
        <input
          type="checkbox"
          checked={autoCheckUpdates}
          onchange={(e) => toggleAutoCheckUpdates(e.currentTarget.checked)}
        />
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label wide">Check for updates automatically</span>
      </label>
    </div>
    <div class="controls">
      <button
        class="primary"
        disabled={updateBusy}
        onclick={() => void emitSettingsCheckUpdates()}
      >
        {update.phase === 'checking' ? 'Checking…' : 'Check now'}
      </button>
      <span class="hint">
        {#if update.phase === 'checking'}
          Asking GitHub what the latest release is.
        {:else if update.upToDate}
          {lastCheckedLabel(update.lastCheckedAt)} — you're on the latest
          release.
        {:else if autoCheckUpdates}
          {lastCheckedLabel(update.lastCheckedAt)}. Griddle Window Manager
          checks again once a day while it's running.
        {:else}
          Automatic checks are off. This button still works — one check, right
          now, because you asked for it.
        {/if}
      </span>
    </div>
    <!-- The privacy trade is the whole reason this setting exists. Say what
         actually leaves the machine, and what does not. -->
    <p class="hint">
      Griddle Window Manager has no telemetry and nothing else in it talks to
      the network.
      A check is a plain request to GitHub for this project's public
      <code>latest.json</code>; the comparison with your version happens on your
      machine. GitHub can see your IP address and the time of the request, the
      way it can for anyone loading a page from it. Nothing about your windows,
      your apps or your configuration is ever sent.
    </p>
    <p class="hint">
      Updates are never installed on their own: Griddle Window Manager tells you
      a release exists, shows you what changed, and waits. Every download is
      checked against the project's signing key before it is allowed to run.
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
  {/if}
</div>

<style>





  /*
   * The bar the sections scroll under. Sticky rather than a separate flex
   * pane so the existing single-scroller markup stays intact; opaque, above
   * the content, and stretched past `.page`'s padding with matching negative
   * margins so nothing shows through at the edges as it passes behind.
   */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--bg);
    margin: 0;
    padding: 0;
    border-bottom: 0;
  }

  /* ---------------------------------------------------------------------
     The band table (Figma 110-344)
     ---------------------------------------------------------------------
     Every setting is a full-width row, 32px tall, with a hairline under it.
     The label cell takes the slack and carries the vertical rule, so the
     controls stack into one column down the right edge no matter how long
     the labels get. Controls are square cells, not floating buttons: the
     grid the widget configures is echoed by the widget's own structure. */
  .rows {
    display: flex;
    flex-direction: column;
  }
  /* The display tab owns the remaining height so its map can fill it. */
  .rows.fill {
    flex: 1 1 auto;
    min-height: 0;
  }

  /* Brand and tab bands. The brand row sits on the panel tone and the tabs on
     the well tone, so the chrome reads as one unit above the settings table
     without needing a heavier divider. */
  /* Band tones follow the design: brand on panel, tabs on surface-2, the
     settings table on surface. Three distinct levels, so the chrome separates
     from the content without needing a heavier rule. */
  .brandrow {
    background: var(--panel);
  }
  .brandrow .wordmark {
    font-size: var(--fs-h1);
    font-weight: var(--fw-bold);
    color: var(--text);
    letter-spacing: -0.01em;
  }
  /* The name completes the lockup without competing with it. */
  .brandrow .product {
    font-size: var(--fs-h2);
    color: var(--muted);
    white-space: nowrap;
  }
  .brandrow .brandmark {
    width: 16px;
    height: 16px;
  }
  .cell.nodivide {
    border-right: 0;
  }
  .ghost.pause.on {
    color: var(--accent);
  }

  .tabrow {
    background: var(--surface-2);
    align-items: stretch;
  }
  .tabrow .tabs {
    display: flex;
    align-items: stretch;
    min-width: 0;
  }
  .tabrow .spacer {
    flex: 1 1 auto;
    border-right: 1px solid var(--line);
  }
  .cell.icon {
    cursor: pointer;
    color: var(--faint);
    border-right: 1px solid var(--line);
  }
  .cell.icon:last-child {
    border-right: 0;
  }
  .cell.icon:hover,
  .cell.icon.sel {
    background: var(--surface);
    color: var(--text);
  }

  .row {
    display: flex;
    align-items: stretch;
    min-height: var(--row-h);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }
  .row.dimmed {
    opacity: 0.55;
  }

  /* The dimension block: one rule underneath it, none inside, and no vertical
     divider either — the numbers already form their own column. */
  .group {
    border-bottom: 1px solid var(--line);
  }
  .group .row {
    border-bottom: 0;
  }
  .group .cell.label {
    border-right: 0;
  }

  .cell {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 var(--cell-w);
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
  }
  /* Takes the slack and owns the vertical rule the controls line up against. */
  .cell.label {
    flex: 1 1 auto;
    justify-content: flex-start;
    gap: var(--sp-2);
    padding: 0 var(--sp-3);
    min-width: 0;
    border-right: 1px solid var(--line);
  }
  .cell.wide {
    flex: 0 0 auto;
    gap: var(--sp-2);
    padding: 0 var(--sp-3);
  }

  /* A row's label is primary text, and everything qualifying it is one step
     down (Figma 112-117). The panel used to sit a step dimmer throughout —
     labels muted, units faint — which read as though every row were disabled. */
  .cell .lbl {
    font-size: var(--fs-sm);
    color: var(--text);
    white-space: nowrap;
  }
  .cell .unit {
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .cell .mon-name {
    font-size: var(--fs-h2);
    font-weight: var(--fw-medium);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cell.step {
    cursor: pointer;
    color: var(--faint);
  }
  .cell.step:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text);
  }
  .cell.step:disabled {
    opacity: 0.35;
    cursor: default;
  }
  /* Fixed, and it stays fixed while you type. A flex item defaults to
     `min-width: auto`, so the focused input's border pushed the cell past its
     basis and shoved the minus button left mid-edit. Pinning the width and
     letting the field fill it means focus changes nothing but the outline. */
  .cell.num {
    flex: 0 0 44px;
    min-width: 0;
  }
  .cell.num :global(.numfield) {
    width: 100%;
    justify-content: center;
  }
  .cell.num :global(.numfield input) {
    width: 100%;
    box-sizing: border-box;
  }

  .ico {
    width: 15px;
    height: 15px;
    flex: 0 0 auto;
    display: block;
  }

  /* "Grid on" — a checkbox in the spec, not a switch: it states a fact
     about the display rather than flipping a mode. */
  .check {
    cursor: pointer;
  }
  .check input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .check .check-label {
    font-size: var(--fs-sm);
    color: var(--text);
  }
  .check .box {
    width: 17px;
    height: 17px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: var(--surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
    color: transparent;
  }
  .check input:checked + .box {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .check input:focus-visible + .box {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .check input:disabled + .box {
    opacity: 0.4;
  }

  .cell.behavior {
    flex: 0 0 46%;
    padding: 0;
  }

  .ghost {
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--text);
  }
  .ghost:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  /* The map is the one band that is not a row: full bleed, its own inset. */
  /* The map takes whatever height is left rather than dictating it. That is
     what lets the window be a fixed size on any monitor: the editor fits
     itself to this box, letterboxing to keep the display's proportions. */
  .mapband {
    background: var(--surface);
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  /* The editor holds the box open; the gallery is laid over it. Swapping this
     way is what keeps "don't change the size of the grid container" true for
     any monitor aspect, without duplicating the editor's sizing maths. */
  .mapstack {
    position: relative;
  }
  .mapstack.swapped .mapinner {
    visibility: hidden;
  }
  .carousel {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .rowhint {
    margin: 0;
    padding: 7px 12px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--faint);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }



  /* Resolution and row hints: the small step, one level below the label. */
  .meta-inline {
    font-size: var(--fs-2xs);
    color: var(--muted);
    white-space: nowrap;
  }









  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
  }

  /* Segments of the tab band, not pills floating in it: square, full height,
     divided by a rule, and the selected one filled solid (Figma 112-234).
     A rounded outline inside a band reads as a second container. */
  .tab {
    display: flex;
    align-items: center;
    padding: 0 14px;
    border: 0;
    border-right: 1px solid var(--line);
    border-radius: 0;
    background: transparent;
    color: var(--faint);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
  }

  .tab:hover:not(.sel) {
    color: var(--text);
    background: var(--surface);
  }

  .tab.sel {
    background: var(--accent);
    color: var(--on-accent);
  }

  /* `+` and the gear are glyphs, not words: square them up so they read as
     controls beside the display names. */
  .tab.glyph {
    min-width: 32px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
    letter-spacing: 0;
  }


  /*
   * `body` is clipped to the rounded frame (settings.css), so the scroll has
   * to live one level in or the content would be cut off at the fold instead
   * of scrolling. `.page` is that scroller: it fills the pop-out exactly and
   * overflows internally, which also keeps the scrollbar inside the rounded
   * corners rather than riding over them.
   */
  .page {
    max-width: 720px;
    margin: 0 auto;
    /* No padding at all: the band table is the panel. Every row runs edge to
       edge and carries its own rule, so an outer gutter would just float the
       whole thing inside a frame it is already acting as. */
    padding: 0;
    display: flex;
    flex-direction: column;
    /* No gap: the bands stack directly, each delimited by its own rule. A
       flex gap here left a strip of ground showing between the tab row and
       the table, which read as a seam in a surface that should be continuous. */
    gap: 0;
    height: 100%;
    box-sizing: border-box;
    /* Fixed window, fixed content: the map absorbs the slack, so there is
       never anything to scroll to. */
    overflow: hidden;
  }


  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .brandmark {
    width: 28px;
    height: 28px;
    flex: none;
    color: var(--text);
  }
  h1 {
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.3px;
    margin: 0;
    color: var(--text);
  }
  .tagline {
    margin: 2px 0 0;
    font-size: 13px;
    color: var(--faint);
  }
  .version {
    margin-left: 8px;
    font-size: 11.5px;
    font-family: var(--font-mono);
    color: var(--faint);
    opacity: 0.8;
  }
  .hint.error {
    color: var(--bad);
  }

  /* Update banner (spec §7): the one card allowed to raise its voice, and
     only while something is actually on offer. */
  .update-banner {
    border-color: var(--accent-line);
    background: linear-gradient(
      180deg,
      var(--accent-soft),
      var(--surface) 70%
    );
  }
  .update-banner.failed {
    border-color: var(--bad);
    background: linear-gradient(180deg, var(--bad-soft), var(--surface) 70%);
  }
  .release-notes {
    max-height: 220px;
    overflow-y: auto;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    /* Release notes are the one place the user needs to read carefully. */
    -webkit-user-select: text;
    user-select: text;
  }
  .progress {
    height: 8px;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    overflow: hidden;
  }
  .progress .bar {
    display: block;
    height: 100%;
    width: 0;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  /* No content length from the server → no fake percentage; a sliding sliver
     says "working" without claiming to know how far along it is. */
  .progress.indeterminate .bar {
    width: 32%;
    transition: none;
    animation: slide 1.3s ease-in-out infinite;
  }
  @keyframes slide {
    0% {
      transform: translateX(-110%);
    }
    100% {
      transform: translateX(340%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress.indeterminate .bar {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }

  .empty {
    color: var(--faint);
    font-size: 14px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--line);
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
    color: var(--text);
  }
  .meta {
    margin: 2px 0 0;
    font-size: 12.5px;
    color: var(--faint);
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
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-line);
  }
  .badge.experimental {
    background: var(--warn-soft);
    color: var(--warn);
    border-color: var(--warn);
  }

  /* Toggle switch */
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }

  /* List row (spec 2026-08-20): the setting's name reads first at the left
     margin and its control sits at the right, so a column of settings scans
     as a list instead of a ragged row of chips. The markup order is
     track-then-label throughout, so `order` does the reordering — cheaper and
     less error-prone than rewriting every switch. */
  .switch.row {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 9px 0;
  }

  .switch.row .switch-label {
    order: -1;
    /* Long labels wrap instead of shoving the toggle off the row. */
    flex: 1 1 auto;
    min-width: 0;
  }

  .switch.row .track {
    flex: 0 0 auto;
  }

  /* Hairlines between adjacent rows, never a trailing one. Each switch sits
     in its own `.controls` wrapper, so the rule targets those siblings. */
  .controls:has(> .switch.row) + .controls:has(> .switch.row) {
    border-top: 1px solid var(--line);
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
    background: var(--surface-2);
    border: 1px solid var(--line);
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
    background: var(--faint);
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .switch input:checked + .track {
    background: var(--accent-line);
    border-color: var(--accent);
  }
  .switch input:checked + .track .thumb {
    transform: translateX(15px);
    background: var(--accent);
  }
  .switch input:focus-visible + .track {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .switch-label {
    font-size: 13px;
    color: var(--muted);
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
    color: var(--faint);
    white-space: nowrap;
  }
  .hotkey-input {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text);
    font: 500 13px/1.2 var(--font-mono);
    padding: 7px 10px;
    width: 180px;
  }
  .hotkey-input:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }


  /* A controls row whose only child is a list-row switch should let it span
     the full card width rather than hugging its content. */
  .controls:has(> .switch.row) {
    display: block;
  }

  /* The coerced-gap note that replaced the old combined label: the field now
     shows what you set, this shows what the grid could actually use. */
  .coerced-note {
    font-size: 12px;
    color: var(--faint);
    white-space: nowrap;
  }

  .pick {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    color: var(--muted);
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
    background: var(--accent-soft);
    color: var(--accent);
    font: 600 12.5px/1 var(--font-body);
    padding: 8px 14px;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .primary:hover:not(:disabled) {
    background: var(--accent-soft);
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
    color: var(--faint);
  }
  .stepper button {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text);
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
    background: var(--accent-soft);
  }
  .stepper button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .tile-count {
    font-size: 12.5px;
    color: var(--faint);
    margin-left: auto;
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--faint);
  }

  .quiet {
    border: 1px solid var(--line);
    border-radius: 9px;
    background: transparent;
    color: var(--faint);
    font: 600 12.5px/1 var(--font-body);
    padding: 8px 14px;
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .quiet:hover {
    border-color: var(--accent);
    color: var(--muted);
  }
  /* Armed destructive action, same palette as the template gallery's. */
  .quiet.danger:hover,
  .quiet.danger.armed {
    border-color: var(--bad);
    background: var(--bad-soft);
    color: var(--bad);
  }

  /* First-run (plan Task 19) */
  .first-run h2 {
    font-size: 17px;
  }
  .fr-copy {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--muted);
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
    border: 1px solid var(--line);
    border-radius: 11px;
    background: var(--surface-2);
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
    background: var(--accent-soft);
  }
  .fr-mon input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .fr-mon:has(input:focus-visible) {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .fr-mon-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .fr-mon-meta {
    font-size: 12px;
    color: var(--faint);
  }

  /* The "no windows here yet" hint. Both states use the existing palette:
     dim when it is merely context, and the normal text colour when it is
     telling you the pick will look idle. Deliberately not a red or an alert
     tone — picking an empty monitor is allowed, just worth knowing first. */
  .fr-mon-windows {
    font-size: 12px;
    color: var(--faint);
    line-height: 1.35;
  }

  .fr-mon-windows.empty {
    color: var(--muted);
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
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-2);
    padding: 4px 6px 4px 12px;
  }
  .excl-chip code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }
  .chip-x {
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--faint);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .chip-x:hover {
    background: var(--bad-soft);
    color: var(--bad);
  }
  .chip-x:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .excl-input {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text);
    font: 500 13px/1.2 var(--font-mono);
    padding: 7px 10px;
    width: 200px;
  }
  .excl-input:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
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
    background: var(--accent-soft);
    border-color: var(--line);
  }
  .pick-row:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .pick-row code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    white-space: nowrap;
  }
  .pick-titles {
    font-size: 12px;
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* App defaults card (spec v0.2 §2) */
  .rule-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rule-row {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--surface-2);
    padding: 6px 8px 6px 12px;
  }
  /* Miniature of the rule's slot inside its grid — the same visual idea as
     the template gallery's previews, so the two read as one language. */
  .rule-preview {
    width: 34px;
    height: 20px;
    flex: none;
    display: block;
    border-radius: 4px;
    background: var(--surface-2);
  }
  .rule-preview .frame {
    fill: none;
    stroke: var(--line);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }
  .rule-preview .slot {
    fill: var(--accent-line);
    stroke: var(--accent);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }
  .rule-exe {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 0 1 auto;
    min-width: 0;
  }
  .rule-scope {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .rule-scope.all {
    color: var(--faint);
    background: var(--surface-2);
    border-color: var(--line);
  }
  .rule-slot {
    font-size: 12px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-left: auto;
  }

  /* Views card (spec v0.2 §3) */
  .view-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .view-row {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--surface-2);
    padding: 6px 8px 6px 12px;
  }
  .view-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 0 1 auto;
    min-width: 0;
  }
  .view-summary {
    font-size: 12px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .view-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .quiet.small {
    padding: 5px 10px;
    font-size: 12px;
  }
  .view-input,
  .view-rename {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text);
    font: 500 13px/1.2 var(--font-body);
    padding: 7px 10px;
    width: 200px;
  }
  .view-rename {
    background: var(--surface);
    padding: 5px 8px;
    width: 160px;
  }
  .view-input:focus-visible,
  .view-rename:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .startup-pick {
    gap: 12px;
  }
  .startup-pick .lbl {
    font-size: 12.5px;
    color: var(--faint);
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
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .floating code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--faint);
    background: var(--surface-2);
    border-radius: 5px;
    padding: 2px 6px;
  }
</style>
