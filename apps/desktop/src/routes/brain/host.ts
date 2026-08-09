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
  type AppConfig,
  type GridSettings,
  type StateSnapshot,
} from '@griddle-wm/brain';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  applyLayout,
  emitPreviewState,
  emitStateSnapshot,
  listMonitors,
  listWindows,
  onDragPos,
  onMonitorsChanged,
  onMoveSizeEnd,
  onMoveSizeStart,
  onWindowAppeared,
  onWindowDestroyed,
  onWindowMinimized,
  onWindowRestored,
  readConfig,
  writeConfig,
} from '../../lib/ipc';

/** How long after the last state change the config is persisted. */
const SAVE_DEBOUNCE_MS = 500;

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

  const brain = new WindowManagerBrain(
    {
      onApply(layout) {
        applyLayout(layout).catch((e) => console.error('apply_layout failed:', e));
      },
      onPreview(p) {
        emitPreviewState(p).catch((e) => console.error('preview-state emit failed:', e));
      },
      onSnapshot(s) {
        lastSnapshot = s;
        emitStateSnapshot(s).catch((e) => console.error('state-snapshot emit failed:', e));
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
    if (g.enabled) brain.enableGrid(g, windows);
  }

  // Native events → brain. Listeners registered after the initial snapshot
  // seeding so an event can never race the constructor.
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
    // NOTE: `settings-move` (editor → brain) is wired in Task 13 alongside
    // the brain's moveTileFromEditor implementation.
  ]);

  const host: BrainHost = {
    brain,
    get lastSnapshot() {
      return lastSnapshot;
    },
    async enableGridOnMonitor(monitorId?: string, cols = 12, rows = 6) {
      const mons = await listMonitors();
      const mon = monitorId
        ? mons.find((m) => m.id === monitorId)
        : (mons.find((m) => m.primary) ?? mons[0]);
      if (!mon) throw new Error(`enableGridOnMonitor: no such monitor ${monitorId ?? ''}`);
      brain.setMonitors(mons);
      const settings: GridSettings = {
        id: `grid:${mon.id}`,
        monitorIds: [mon.id],
        cols,
        rows,
        mode: 'collision',
        enabled: true,
        activeTemplateId: null,
      };
      brain.enableGrid(settings, await listWindows());
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
      for (const u of unlisteners) u();
    },
  };
  return host;
}
