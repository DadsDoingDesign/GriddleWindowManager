// Brain host (plan Task 12): instantiates WindowManagerBrain in the hidden
// main webview and wires it both directions —
//   native events (window-appeared, drag-pos, ...)  → brain methods
//   brain.onApply                                    → apply_layout command
//   brain.onPreview                                  → `preview-state` event
//   brain.onSnapshot                                 → `state-snapshot` event
// plus config load/save through read_config/write_config (saves are
// debounced: every snapshot marks the config dirty, one timer flushes it).

import {
  DEFAULT_PLACEMENT_MODE,
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
  brainAlive,
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
  windowIsTracked,
  onSettingsApplyView,
  onSettingsCaptureView,
  onSettingsCheckUpdates,
  onSettingsDeleteView,
  onSettingsDismissUpdate,
  onSettingsInstallUpdate,
  onSettingsRemoveAppRule,
  onSettingsRenameView,
  onSettingsSetAppRule,
  onSettingsSetDims,
  onSettingsSetExclusions,
  onSettingsSetMode,
  onSettingsSetPrefs,
  onSettingsSetSpacing,
  onSettingsSetStartupView,
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
import { startUpdater } from './updates';

/** How long after the last state change the config is persisted. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Heartbeat cadence (critique round 2): a healthy brain page invokes
 * `brain_alive` this often; Rust's watchdog respawns the window after
 * missing beats for `HEARTBEAT_TIMEOUT` (90 s). Only started once the host
 * booted successfully — a page whose boot threw sends no beats, so the
 * watchdog rebuilds it (with a give-up cap against a boot that always
 * fails).
 *
 * Throttling note (critique round 3): this page is permanently hidden, and
 * Chromium's intensive wake-up throttling aligns hidden-page `setInterval`s
 * to one wake-up per minute after ~5 min. The main window passes
 * `--disable-background-timer-throttling` (tauri.conf.json) to switch that
 * off, Rust's timeout (90 s) sits above the worst-case throttled cadence
 * anyway, and every `apply_layout`/`list_windows` invocation also counts as
 * a beat — three independent reasons a healthy-but-throttled brain is never
 * respawned.
 */
const HEARTBEAT_MS = 3000;

/**
 * Dock/undock fires WM_DISPLAYCHANGE plus several WM_SETTINGCHANGE
 * (SPI_SETWORKAREA) messages in a burst, each arriving as a
 * `monitors-changed` event; every one triggers a full window sweep and a
 * `setMonitors` that may tear down and revive grids. Coalescing the burst
 * makes one transition do the work (and re-place windows) once.
 */
const MONITORS_DEBOUNCE_MS = 250;

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
   * grid on a monitor (default: primary) with the given dims.
   */
  enableGridOnMonitor(monitorId?: string, cols?: number, rows?: number): Promise<void>;
  /** Flush any pending debounced config save immediately. */
  saveNow(): Promise<void>;
  /** Detach all event listeners (used on teardown/HMR). */
  destroy(): void;
}

export async function startBrainHost(): Promise<BrainHost> {
  const storedCfg = await readConfig();
  const cfg: AppConfig = storedCfg ?? defaultConfig();

  let lastSnapshot: StateSnapshot | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let monitorsDebounce: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  /**
   * First-run write suppression (critique round 3): on a genuinely fresh
   * install (no config on disk) boot alone emits a snapshot (`setMonitors`),
   * which would write a default config ~1–2 s after launch — racing the
   * settings window's `readConfig() === null` first-run check and creating
   * `%APPDATA%/griddle-wm` for users who launch once and quit. Until the
   * user actually does something (any settings-* event, tray toggle, pause
   * flip, or an explicit `saveNow`), snapshots do not schedule saves.
   */
  let userActed = storedCfg !== null;
  const markUserAction = () => {
    userActed = true;
  };

  const save = async () => {
    saveTimer = null;
    try {
      await writeConfig(brain.exportConfig());
    } catch (e) {
      console.error('write_config failed:', e);
    }
  };

  const scheduleSave = () => {
    if (destroyed || !userActed) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  };

  // -- Overlay lifecycle (plan Task 15) -------------------------------------
  // The brain's preview events drive the native overlay windows: a visible
  // preview shows the overlay(s) of the grid's monitor(s); a hidden preview
  // hides them after the overlay page's fade-out has played.
  const overlayHideTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Monitors whose overlay window is currently shown (or being shown). */
  const overlaysShown = new Set<string>();

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
        // Preview emits arrive on every footprint change during a drag; the
        // native window only needs showing on the hidden→visible transition.
        if (!overlaysShown.has(monitorId)) {
          overlaysShown.add(monitorId);
          showOverlay(monitorId).catch((e) => {
            overlaysShown.delete(monitorId); // retry on the next emit
            console.error('show_overlay failed:', e);
          });
        }
      } else if (pending === undefined && overlaysShown.has(monitorId)) {
        overlayHideTimers.set(
          monitorId,
          setTimeout(() => {
            overlayHideTimers.delete(monitorId);
            overlaysShown.delete(monitorId);
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

  /**
   * Enabled grids that currently hold no windows. Enabling a grid on a
   * monitor you have no windows on is a legitimate no-op — `enableGrid`
   * sweeps only windows whose `monitorId` matches — but it used to be a
   * *silent* one, which read as "the app is broken"
   * (docs/qa-handoff-2026-08-19.md, defect 3). Counting them lets the tray
   * say so.
   */
  const idleGridCountOf = (grids: GridSettings[]): number =>
    grids.filter((g) => g.enabled && (lastSnapshot?.tiles[g.id]?.length ?? 0) === 0).length;

  const pushTrayState = (grids?: GridSettings[], floatingCount?: number) => {
    const source = grids ?? lastSnapshot?.grids ?? brain.exportConfig().grids;
    const floating = floatingCount ?? lastSnapshot?.floating.length ?? 0;
    updateTray(enabledMonitorIdsOf(source), floating, idleGridCountOf(source)).catch((e) =>
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
        pushTrayState(s.grids, s.floating.length);
        scheduleSave();
      },
    },
    cfg,
  );

  // Seed monitors with a fresh window sweep: setMonitors itself revives
  // every enabled grid whose monitors are present (restoring the persisted
  // layouts against the sweep), so boot and monitor-hotplug share one path.
  const monitors = await listMonitors();
  const windows = await listWindows();
  brain.setMonitors(monitors, windows);
  // Startup view (spec v0.2 §3): applied right after the boot placement, so
  // it works with autostart — the view's grid settings land immediately and
  // its assignments stay pending claims for 120 s, catching the apps that
  // launch after us. `applyView` no-ops on a dangling id.
  if (cfg.startupViewId !== null) {
    brain.applyView(cfg.startupViewId, windows);
  }
  for (const g of cfg.grids) {
    if (g.enabled) prewarmOverlays(g.monitorIds);
  }
  // Bring the tray in line with the restored config even when no grid is
  // enabled (no snapshot fired above → stale checks would linger otherwise).
  pushTrayState();

  /** Flush any pending debounced save immediately. */
  const flushSave = async () => {
    markUserAction(); // an explicit flush always writes
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await save();
  };

  // Opt-in update checks (spec §7). Creating the driver performs the launch
  // check — which the pure policy refuses outright while `autoCheckUpdates`
  // is false, so a default install still never touches the network. The
  // driver gets `flushSave` because the installer handoff has to persist the
  // config *before* the shell freezes and the process restarts.
  const updater = startUpdater({
    autoCheckEnabled: () => brain.exportConfig().autoCheckUpdates,
    persistNow: flushSave,
  });

  /** Enable a grid on a monitor against a fresh window sweep. */
  const enableOnMonitor = async (monitorId?: string, cols = 12, rows = 6) => {
    markUserAction();
    const mons = await listMonitors();
    const mon = monitorId
      ? mons.find((m) => m.id === monitorId)
      : (mons.find((m) => m.primary) ?? mons[0]);
    if (!mon) throw new Error(`enableGridOnMonitor: no such monitor ${monitorId ?? ''}`);
    const wins = await listWindows();
    brain.setMonitors(mons, wins);
    const existing = brain
      .exportConfig()
      .grids.find((g) => g.id === `grid:${mon.id}`);
    const settings: GridSettings = {
      id: `grid:${mon.id}`,
      monitorIds: [mon.id],
      cols,
      rows,
      // A grid that existed before keeps its mode across a disable/enable
      // cycle; a brand-new one starts in the default placement mode.
      mode: existing?.mode ?? DEFAULT_PLACEMENT_MODE,
      enabled: true,
      activeTemplateId: null,
      // Spacing survives a disable/enable cycle like the mode does.
      gap: existing?.gap ?? 0,
      padding: existing?.padding ?? 0,
    };
    brain.enableGrid(settings, wins);
    prewarmOverlays(settings.monitorIds);
  };

  /**
   * Enable a spanning grid over several monitors against a fresh window
   * sweep (plan Task 17). The brain tears down any live grid sharing one of
   * those monitors — spanning replaces per-monitor grids.
   */
  const enableSpan = async (monitorIds: string[], cols = 12, rows = 6) => {
    markUserAction();
    const mons = await listMonitors();
    const wins = await listWindows();
    brain.setMonitors(mons, wins);
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
      mode: existing?.mode ?? DEFAULT_PLACEMENT_MODE,
      enabled: true,
      activeTemplateId: null,
      gap: existing?.gap ?? 0,
      padding: existing?.padding ?? 0,
    };
    brain.enableGrid(settings, wins);
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

  /**
   * Manual "Apply now" (spec v0.2 §3): same claim mechanism as startup —
   * the brain re-places a fresh sweep and the assignments left over stay
   * claimable for the 120 s window.
   */
  const applyViewNow = async (viewId: string) => {
    markUserAction();
    brain.applyView(viewId, await listWindows());
  };

  // Native events → brain, plus settings-window inputs (contract §C2).
  // Listeners registered after the initial snapshot seeding so an event can
  // never race the constructor.
  /**
   * Security hardening (docs/security-review.md, "event spoofing between
   * webviews"): Tauri events carry no sender identity, so any webview in the
   * process could forge a `window-destroyed` for a live managed hwnd and
   * make the brain drop its tile. A genuine destroy/hide/cloak is untracked
   * by the hook *before* the event is emitted, so an O(1) `window_is_tracked`
   * check exposes the forgery — no per-event desktop sweep (which serialized
   * an EnumWindows + per-window probe walk behind every close/hide and could
   * wipe concurrently-appearing windows from the live set). If the check
   * itself fails, the event is trusted: leaking a dead tile is worse than
   * dropping one that the window's next appearance re-adds.
   */
  const confirmedWindowDestroyed = async (hwnd: string) => {
    try {
      if (await windowIsTracked(hwnd)) {
        console.warn(`ignoring window-destroyed for live hwnd ${hwnd} (forged or stale)`);
        return;
      }
    } catch (e) {
      console.error('window-destroyed confirmation failed:', e);
    }
    brain.windowDestroyed(hwnd);
  };

  /**
   * Pause→resume reconciliation (critique fix): while paused the tracker
   * suppresses every event but keeps its live set current, so windows opened
   * during the pause are tracked-but-unannounced, windows closed during it
   * linger as ghost tiles, and windows the user moved or minimized diverge
   * from their slots. `brain.reconcile` converges all of it against a fresh
   * sweep: destroys for gone windows, the minimize flow for now-iconic ones,
   * a re-snap for physically moved ones, placement for new ones.
   */
  const reconcileAfterResume = async () => {
    try {
      brain.reconcile(await listWindows());
    } catch (e) {
      console.error('resume reconciliation failed:', e);
    }
  };

  const unlisteners: UnlistenFn[] = await Promise.all([
    onWindowAppeared((w) => brain.windowAppeared(w)),
    onWindowDestroyed((p) => void confirmedWindowDestroyed(p.hwnd)),
    onWindowMinimized((p) => brain.windowMinimized(p.hwnd)),
    onWindowRestored((w) => brain.windowRestored(w)),
    onMoveSizeStart((p) => brain.moveSizeStart(p.hwnd)),
    onDragPos((p) => brain.dragMoved(p)),
    onMoveSizeEnd((p) =>
      brain.moveSizeEnd(p.hwnd, { x: p.x, y: p.y, width: p.width, height: p.height }),
    ),
    // Monitor hotplug / geometry change: feed a fresh window sweep so grids
    // whose monitors (re)appeared revive with their windows. The burst a
    // single dock/undock produces is debounced to one transition.
    onMonitorsChanged((mons) => {
      if (monitorsDebounce !== null) clearTimeout(monitorsDebounce);
      monitorsDebounce = setTimeout(() => {
        monitorsDebounce = null;
        listWindows()
          .then((wins) => brain.setMonitors(mons, wins))
          .catch((e) => {
            console.error('monitors-changed sweep failed:', e);
            brain.setMonitors(mons);
          });
      }, MONITORS_DEBOUNCE_MS);
    }),
    // Settings window → brain (plan Task 13).
    onSettingsReady(() => {
      if (lastSnapshot) {
        emitStateSnapshot(lastSnapshot).catch((e) =>
          console.error('state-snapshot re-emit failed:', e),
        );
      }
      // A settings window opened by the tray's update entry must find the
      // offer already on screen, so the update state is re-emitted too.
      updater.broadcast();
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
    onSettingsMove((p) => {
      markUserAction();
      brain.moveTileFromEditor(p.gridId, p.hwnd, p.slot);
    }),
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
    onSettingsDisableGrid((p) => {
      markUserAction();
      brain.disableGrid(p.gridId);
    }),
    onSettingsSetDims((p) => {
      markUserAction();
      brain.reflowGrid(p.gridId, p.cols, p.rows);
    }),
    // Settings window → brain (plan Task 16): mode toggle + template gallery.
    onSettingsSetMode((p) => {
      markUserAction();
      brain.setMode(p.gridId, p.mode);
    }),
    // Settings window → brain (spec v0.2 §1): gap/padding steppers — the
    // brain clamps and re-applies the grid live in one batch.
    onSettingsSetSpacing((p) => {
      markUserAction();
      brain.setSpacing(p.gridId, p.gap, p.padding);
    }),
    onSettingsCaptureTemplate((p) => {
      markUserAction();
      try {
        brain.captureTemplate(p.gridId, p.name);
      } catch (e) {
        // Grid was disabled between the click and the event — nothing to do.
        console.error('settings-capture-template failed:', e);
      }
    }),
    onSettingsApplyTemplate((p) => {
      markUserAction();
      brain.applyTemplate(p.gridId, p.templateId);
    }),
    onSettingsDeleteTemplate((p) => {
      markUserAction();
      brain.deleteTemplate(p.templateId);
    }),
    // Settings window → brain (spec v0.2 §2): per-app defaults. The tile
    // context menu saves/removes rules; the App-defaults card deletes them.
    // Neither ever moves an already-managed window (rules fire on
    // window-appeared only), so these just mutate + persist.
    onSettingsSetAppRule((p) => {
      markUserAction();
      brain.setAppRule(p.rule);
    }),
    onSettingsRemoveAppRule((p) => {
      markUserAction();
      brain.removeAppRule(p.exe, p.gridId);
    }),
    // Settings window → brain (spec v0.2 §3): startup views. Capture
    // mirrors captureTemplate's disabled-grid race handling; apply sweeps
    // the desktop so present windows claim their assignments immediately.
    onSettingsCaptureView((p) => {
      markUserAction();
      try {
        brain.captureView(p.name);
      } catch (e) {
        // Every grid was disabled between the click and the event.
        console.error('settings-capture-view failed:', e);
      }
    }),
    onSettingsApplyView((p) =>
      applyViewNow(p.viewId).catch((e) =>
        console.error('settings-apply-view failed:', e),
      ),
    ),
    onSettingsRenameView((p) => {
      markUserAction();
      brain.renameView(p.viewId, p.name);
    }),
    onSettingsDeleteView((p) => {
      markUserAction();
      brain.deleteView(p.viewId);
    }),
    onSettingsSetStartupView((p) => {
      markUserAction();
      brain.setStartupView(p.viewId);
    }),
    // Settings window → brain (plan Task 19): exclusions editor. The brain
    // unmanages newly excluded windows immediately; the debounced config
    // save then re-syncs the tracker's live filter (write_config).
    onSettingsSetExclusions((p) => {
      markUserAction();
      brain.setExclusions(p.exclusions);
    }),
    // Shell events (plan Task 18): Rust's authoritative pause flag is
    // mirrored into the brain (persists + updates the settings UI via the
    // snapshot); the settings General card sends autostart/hotkey prefs; the
    // tray toggles grid coverage per monitor.
    onPausedChanged((paused) => {
      markUserAction(); // pause is only ever flipped by the user (tray/settings)
      brain.setShellPrefs({ paused });
      // Spec §6 calls pause a panic button — resuming must reconcile the
      // brain with whatever happened to the desktop while it was deaf.
      if (!paused) void reconcileAfterResume();
    }),
    onSettingsSetPrefs((p) => {
      markUserAction();
      brain.setShellPrefs(p);
      // Opting in should answer the question the user just asked, not wait
      // for the next poll. Opting out needs nothing: the policy refuses.
      if (p.autoCheckUpdates === true) updater.maybeAutoCheck();
    }),
    // Update checks (spec §7). The settings window decides nothing on its
    // own — it sends intents and the driver applies the same pure policy to
    // all three. "Check now" is honoured whatever the toggle says (the click
    // is the consent); install only ever proceeds against a live offer.
    onSettingsCheckUpdates(() => {
      void updater.checkNow();
    }),
    onSettingsInstallUpdate(() => {
      void updater.installNow();
    }),
    onSettingsDismissUpdate(() => updater.dismiss()),
    onTrayToggleGrid((p) =>
      toggleFromTray(p.monitorId).catch((e) => {
        console.error('tray-toggle-grid failed:', e);
        // The click optimistically flipped the check; put truth back.
        pushTrayState();
      }),
    ),
  ]);

  // Heartbeat: the host is fully wired — start telling Rust we're alive.
  // The first beat also clears the watchdog's respawn counter after a
  // successful respawn.
  const beatTimer = setInterval(() => {
    brainAlive().catch((e) => console.error('brain_alive failed:', e));
  }, HEARTBEAT_MS);
  brainAlive().catch((e) => console.error('brain_alive failed:', e));

  const host: BrainHost = {
    brain,
    get lastSnapshot() {
      return lastSnapshot;
    },
    async enableGridOnMonitor(monitorId?: string, cols = 12, rows = 6) {
      await enableOnMonitor(monitorId, cols, rows);
    },
    async saveNow() {
      await flushSave();
    },
    destroy() {
      destroyed = true;
      updater.destroy();
      clearInterval(beatTimer);
      if (monitorsDebounce !== null) clearTimeout(monitorsDebounce);
      if (saveTimer !== null) clearTimeout(saveTimer);
      for (const t of overlayHideTimers.values()) clearTimeout(t);
      overlayHideTimers.clear();
      for (const u of unlisteners) u();
    },
  };
  return host;
}
