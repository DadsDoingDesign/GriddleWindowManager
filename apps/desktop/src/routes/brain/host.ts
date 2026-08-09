// Brain host (plan Task 12): instantiates WindowManagerBrain in the hidden
// main webview and wires it both directions —
//   native events (window-appeared, drag-pos, ...)  → brain methods
//   brain.onApply                                    → apply_layout command
//   brain.onPreview                                  → `preview-state` event
//   brain.onSnapshot                                 → `state-snapshot` event
// plus config load/save through read_config/write_config (saves are
// debounced: every snapshot marks the config dirty, one timer flushes it).

import {
  WindowManagerBrain,
  defaultConfig,
  spanGridId,
  type AppConfig,
  type GridSettings,
  type StateSnapshot,
} from '@griddle-wm/brain';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  applyLayout,
  emitPreviewState,
  emitStateSnapshot,
  hideOverlay,
  listMonitors,
  listWindows,
  onDragPos,
  onMonitorsChanged,
  onMoveSizeEnd,
  onMoveSizeStart,
  onOverlayReady,
  onSettingsApplyTemplate,
  onSettingsCaptureTemplate,
  onSettingsDeleteTemplate,
  onSettingsDisableGrid,
  onSettingsEnableGrid,
  onSettingsEnableSpan,
  onPausedChanged,
  onSettingsMove,
  onSettingsReady,
  onSettingsSetDims,
  onSettingsSetMode,
  onSettingsSetPrefs,
  onTrayToggleGrid,
  onWindowAppeared,
  onWindowDestroyed,
  onWindowMinimized,
  onWindowRestored,
  readConfig,
  showOverlay,
  updateTray,
  writeConfig,
} from '../../lib/ipc';

/** How long after the last state change the config is persisted. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Delay between the brain hiding a preview and the native overlay window
 * being hidden — long enough for the overlay page's 120 ms opacity fade to
 * finish, short enough to never be visible as lag.
 */
const OVERLAY_FADE_OUT_MS = 200;

export interface BrainHost {
  brain: WindowManagerBrain;
  /** Last snapshot the brain emitted (for debug display). */
  readonly lastSnapshot: StateSnapshot | null;
  /**
   * Convenience for the plan's manual smoke test and the tray: enable a
   * collision grid on a monitor (default: primary) with the given dims.
   */
  enableGridOnMonitor(monitorId?: string, cols?: number, rows?: number): Promise<void>;
  /** Flush any pending debounced config save immediately. */
  saveNow(): Promise<void>;
  /** Detach all event listeners (used on teardown/HMR). */
  destroy(): void;
}

export async function startBrainHost(): Promise<BrainHost> {
  const cfg: AppConfig = (await readConfig()) ?? defaultConfig();

  let lastSnapshot: StateSnapshot | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const save = async () => {
    saveTimer = null;
    try {
      await writeConfig(brain.exportConfig());
    } catch (e) {
      console.error('write_config failed:', e);
    }
  };

  const scheduleSave = () => {
    if (destroyed) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  };

  // -- Overlay lifecycle (plan Task 15) -------------------------------------
  // The brain's preview events drive the native overlay windows: a visible
  // preview shows the overlay(s) of the grid's monitor(s); a hidden preview
  // hides them after the overlay page's fade-out has played.
  const overlayHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Monitors covered by a grid id, from the last snapshot or the id itself. */
  const monitorIdsForGrid = (gridId: string): string[] => {
    const fromSnapshot = lastSnapshot?.grids.find((g) => g.id === gridId)?.monitorIds;
    if (fromSnapshot && fromSnapshot.length > 0) return fromSnapshot;
    // Fallback: grid ids are `grid:<monitorId>` or `grid:span:<a+b>` (plan
    // global constraints), so the monitors are recoverable from the id.
    if (gridId.startsWith('grid:span:')) return gridId.slice('grid:span:'.length).split('+');
    if (gridId.startsWith('grid:')) return [gridId.slice('grid:'.length)];
    return [];
  };

  const syncOverlays = (gridId: string, visible: boolean) => {
    for (const monitorId of monitorIdsForGrid(gridId)) {
      const pending = overlayHideTimers.get(monitorId);
      if (visible) {
        if (pending !== undefined) {
          clearTimeout(pending);
          overlayHideTimers.delete(monitorId);
        }
        showOverlay(monitorId).catch((e) => console.error('show_overlay failed:', e));
      } else if (pending === undefined) {
        overlayHideTimers.set(
          monitorId,
          setTimeout(() => {
            overlayHideTimers.delete(monitorId);
            hideOverlay(monitorId).catch((e) => console.error('hide_overlay failed:', e));
          }, OVERLAY_FADE_OUT_MS),
        );
      }
    }
  };

  /**
   * Create the overlay windows for these monitors hidden, so the first drag
   * does not wait for WebView2 to spin up (`hide_overlay` pre-warm, C2
   * Task 15 extension).
   */
  const prewarmOverlays = (monitorIds: string[]) => {
    for (const monitorId of monitorIds) {
      hideOverlay(monitorId).catch((e) => console.error('overlay pre-warm failed:', e));
    }
  };

  // -- Tray sync (plan Task 18) ----------------------------------------------
  // The tray's per-monitor check items mirror which monitors are covered by
  // an enabled grid; every snapshot pushes the truth into `update_tray`.
  const enabledMonitorIdsOf = (grids: GridSettings[]): string[] => [
    ...new Set(grids.filter((g) => g.enabled).flatMap((g) => g.monitorIds)),
  ];

  const pushTrayState = (grids?: GridSettings[]) => {
    const source = grids ?? lastSnapshot?.grids ?? brain.exportConfig().grids;
    updateTray(enabledMonitorIdsOf(source)).catch((e) =>
      console.error('update_tray failed:', e),
    );
  };

  const brain = new WindowManagerBrain(
    {
      onApply(layout) {
        applyLayout(layout).catch((e) => console.error('apply_layout failed:', e));
      },
      onPreview(p) {
        emitPreviewState(p).catch((e) => console.error('preview-state emit failed:', e));
        syncOverlays(p.gridId, p.visible);
      },
      onSnapshot(s) {
        lastSnapshot = s;
        emitStateSnapshot(s).catch((e) => console.error('state-snapshot emit failed:', e));
        pushTrayState(s.grids);
        scheduleSave();
      },
    },
    cfg,
  );

  // Seed monitors before any placement, then bring enabled grids back up
  // against the current desktop.
  const monitors = await listMonitors();
  brain.setMonitors(monitors);
  const windows = await listWindows();
  for (const g of cfg.grids) {
    if (g.enabled) {
      brain.enableGrid(g, windows);
      prewarmOverlays(g.monitorIds);
    }
  }
  // Bring the tray in line with the restored config even when no grid is
  // enabled (no snapshot fired above → stale checks would linger otherwise).
  pushTrayState();

  /** Enable a collision grid on a monitor against a fresh window sweep. */
  const enableOnMonitor = async (monitorId?: string, cols = 12, rows = 6) => {
    const mons = await listMonitors();
    const mon = monitorId
      ? mons.find((m) => m.id === monitorId)
      : (mons.find((m) => m.primary) ?? mons[0]);
    if (!mon) throw new Error(`enableGridOnMonitor: no such monitor ${monitorId ?? ''}`);
    brain.setMonitors(mons);
    const existing = brain
      .exportConfig()
      .grids.find((g) => g.id === `grid:${mon.id}`);
    const settings: GridSettings = {
      id: `grid:${mon.id}`,
      monitorIds: [mon.id],
      cols,
      rows,
      mode: existing?.mode ?? 'collision',
      enabled: true,
      activeTemplateId: null,
    };
    brain.enableGrid(settings, await listWindows());
    prewarmOverlays(settings.monitorIds);
  };

  /**
   * Enable a spanning grid over several monitors against a fresh window
   * sweep (plan Task 17). The brain tears down any live grid sharing one of
   * those monitors — spanning replaces per-monitor grids.
   */
  const enableSpan = async (monitorIds: string[], cols = 12, rows = 6) => {
    const mons = await listMonitors();
    brain.setMonitors(mons);
    const ids = [...new Set(monitorIds)]
      .filter((id) => mons.some((m) => m.id === id))
      .sort();
    if (ids.length < 2) {
      throw new Error(`enableSpan: need at least 2 present monitors, got ${ids.length}`);
    }
    const gridId = spanGridId(ids);
    const existing = brain.exportConfig().grids.find((g) => g.id === gridId);
    const settings: GridSettings = {
      id: gridId,
      monitorIds: ids,
      cols,
      rows,
      mode: existing?.mode ?? 'collision',
      enabled: true,
      activeTemplateId: null,
    };
    brain.enableGrid(settings, await listWindows());
    prewarmOverlays(ids);
  };

  /**
   * Tray toggle (plan Task 18): flip grid coverage for a monitor. A monitor
   * covered by any enabled grid (per-monitor or spanning) gets that grid
   * disabled; an uncovered one gets its per-monitor grid (re-)enabled with
   * its remembered dims. Either path snapshots, which re-syncs the tray.
   */
  const toggleFromTray = async (monitorId: string) => {
    const grids = brain.exportConfig().grids;
    const covering = grids.find((g) => g.enabled && g.monitorIds.includes(monitorId));
    if (covering) {
      brain.disableGrid(covering.id);
      return;
    }
    const remembered = grids.find((g) => g.id === `grid:${monitorId}`);
    await enableOnMonitor(monitorId, remembered?.cols ?? 12, remembered?.rows ?? 6);
  };

  // Native events → brain, plus settings-window inputs (contract §C2).
  // Listeners registered after the initial snapshot seeding so an event can
  // never race the constructor.
  const unlisteners: UnlistenFn[] = await Promise.all([
    onWindowAppeared((w) => brain.windowAppeared(w)),
    onWindowDestroyed((p) => brain.windowDestroyed(p.hwnd)),
    onWindowMinimized((p) => brain.windowMinimized(p.hwnd)),
    onWindowRestored((w) => brain.windowRestored(w)),
    onMoveSizeStart((p) => brain.moveSizeStart(p.hwnd)),
    onDragPos((p) => brain.dragMoved(p)),
    onMoveSizeEnd((p) =>
      brain.moveSizeEnd(p.hwnd, { x: p.x, y: p.y, width: p.width, height: p.height }),
    ),
    onMonitorsChanged((mons) => brain.setMonitors(mons)),
    // Settings window → brain (plan Task 13).
    onSettingsReady(() => {
      if (lastSnapshot) {
        emitStateSnapshot(lastSnapshot).catch((e) =>
          console.error('state-snapshot re-emit failed:', e),
        );
      }
    }),
    // Overlay webview → brain (plan Task 15): same re-emit, so a freshly
    // created overlay learns its grid's dims without waiting for a change.
    onOverlayReady(() => {
      if (lastSnapshot) {
        emitStateSnapshot(lastSnapshot).catch((e) =>
          console.error('state-snapshot re-emit failed:', e),
        );
      }
    }),
    onSettingsMove((p) => brain.moveTileFromEditor(p.gridId, p.hwnd, p.slot)),
    onSettingsEnableGrid((p) =>
      enableOnMonitor(p.monitorId, p.cols, p.rows).catch((e) =>
        console.error('settings-enable-grid failed:', e),
      ),
    ),
    // Settings window → brain (plan Task 17): spanning grids.
    onSettingsEnableSpan((p) =>
      enableSpan(p.monitorIds, p.cols, p.rows).catch((e) =>
        console.error('settings-enable-span failed:', e),
      ),
    ),
    onSettingsDisableGrid((p) => brain.disableGrid(p.gridId)),
    onSettingsSetDims((p) => brain.reflowGrid(p.gridId, p.cols, p.rows)),
    // Settings window → brain (plan Task 16): mode toggle + template gallery.
    onSettingsSetMode((p) => brain.setMode(p.gridId, p.mode)),
    onSettingsCaptureTemplate((p) => {
      try {
        brain.captureTemplate(p.gridId, p.name);
      } catch (e) {
        // Grid was disabled between the click and the event — nothing to do.
        console.error('settings-capture-template failed:', e);
      }
    }),
    onSettingsApplyTemplate((p) => brain.applyTemplate(p.gridId, p.templateId)),
    onSettingsDeleteTemplate((p) => brain.deleteTemplate(p.templateId)),
    // Shell events (plan Task 18): Rust's authoritative pause flag is
    // mirrored into the brain (persists + updates the settings UI via the
    // snapshot); the settings General card sends autostart/hotkey prefs; the
    // tray toggles grid coverage per monitor.
    onPausedChanged((paused) => brain.setShellPrefs({ paused })),
    onSettingsSetPrefs((p) => brain.setShellPrefs(p)),
    onTrayToggleGrid((p) =>
      toggleFromTray(p.monitorId).catch((e) => {
        console.error('tray-toggle-grid failed:', e);
        // The click optimistically flipped the check; put truth back.
        pushTrayState();
      }),
    ),
  ]);

  const host: BrainHost = {
    brain,
    get lastSnapshot() {
      return lastSnapshot;
    },
    async enableGridOnMonitor(monitorId?: string, cols = 12, rows = 6) {
      await enableOnMonitor(monitorId, cols, rows);
    },
    async saveNow() {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await save();
    },
    destroy() {
      destroyed = true;
      if (saveTimer !== null) clearTimeout(saveTimer);
      for (const t of overlayHideTimers.values()) clearTimeout(t);
      overlayHideTimers.clear();
      for (const u of unlisteners) u();
    },
  };
  return host;
}
