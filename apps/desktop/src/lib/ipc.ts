// Contract §C2 — typed wrappers over @tauri-apps/api for every event and
// command name in the contract. This is the only file in the frontend that
// spells event/command names; never invent new ones here without extending
// the contract file (docs/superpowers/plans/2026-08-08-griddle-wm.md) first.

import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppConfig,
  AppRule,
  ApplyLayout,
  DragPos,
  Hwnd,
  MonitorInfo,
  PreviewState,
  StateSnapshot,
  WindowInfo,
} from '@griddle-wm/brain';

// ---------------------------------------------------------------------------
// Event payloads that exist only on the wire (C2), mirrored from ipc.rs
// ---------------------------------------------------------------------------

/** Payload of `window-destroyed`, `window-minimized`, `movesize-start`. */
export interface HwndPayload {
  hwnd: Hwnd;
}

/** Payload of `movesize-end`: final extended-frame rect of the drag. */
export interface MoveSizeEndPayload {
  hwnd: Hwnd;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Payload of `tray-toggle-grid`. */
export interface TrayToggleGridPayload {
  monitorId: string;
}

/** Payload of `settings-move` (settings editor → brain, plan Task 13). */
export interface SettingsMovePayload {
  gridId: string;
  hwnd: Hwnd;
  slot: { col: number; row: number; w: number; h: number };
}

/** Payload of `settings-enable-grid` (settings → brain, plan Task 13). */
export interface SettingsEnableGridPayload {
  monitorId: string;
  cols: number;
  rows: number;
}

/** Payload of `settings-disable-grid` (settings → brain, plan Task 13). */
export interface SettingsDisableGridPayload {
  gridId: string;
}

/**
 * Payload of `settings-enable-span` (settings → brain, plan Task 17): create
 * a spanning grid over the selected monitors. The brain derives the grid id
 * (`grid:span:<sorted ids joined by +>`) and tears down any per-monitor grid
 * on those monitors.
 */
export interface SettingsEnableSpanPayload {
  monitorIds: string[];
  cols: number;
  rows: number;
}

/** Payload of `settings-set-dims` (settings → brain, plan Task 13). */
export interface SettingsSetDimsPayload {
  gridId: string;
  cols: number;
  rows: number;
}

/** Payload of `settings-set-mode` (settings → brain, plan Task 16). */
export interface SettingsSetModePayload {
  gridId: string;
  mode: 'collision' | 'overlay';
}

/**
 * Payload of `settings-set-spacing` (settings → brain, spec v0.2 §1): the
 * gap/padding steppers on a monitor or span card. Routed to `setSpacing`,
 * which clamps into 0..64 and re-applies the whole grid in one batch.
 */
export interface SettingsSetSpacingPayload {
  gridId: string;
  gap: number;
  padding: number;
}

/** Payload of `settings-capture-template` (settings → brain, plan Task 16). */
export interface SettingsCaptureTemplatePayload {
  gridId: string;
  name: string;
}

/** Payload of `settings-apply-template` (settings → brain, plan Task 16). */
export interface SettingsApplyTemplatePayload {
  gridId: string;
  templateId: string;
}

/** Payload of `settings-delete-template` (settings → brain, plan Task 16). */
export interface SettingsDeleteTemplatePayload {
  templateId: string;
}

/**
 * Payload of `settings-set-exclusions` (settings → brain, plan Task 19): the
 * full exclusion list as edited (exe basenames; the brain normalizes). The
 * brain unmanages windows of newly excluded exes immediately and persists the
 * list; `write_config` then re-syncs the tracker's live filter.
 */
export interface SettingsSetExclusionsPayload {
  exclusions: string[];
}

/**
 * Payload of `settings-set-app-rule` (settings → brain, spec v0.2 §2): a
 * per-app default saved from the editor tile context menu. Routed to
 * `setAppRule` — upsert by (exe, gridId); `gridId: null` scopes the rule to
 * every grid. Never moves already-managed windows.
 */
export interface SettingsSetAppRulePayload {
  rule: AppRule;
}

/**
 * Payload of `settings-remove-app-rule` (settings → brain, spec v0.2 §2):
 * the context menu's remove entries and the App-defaults card's delete
 * button. Routed to `removeAppRule` for exactly that (exe, gridId) scope.
 */
export interface SettingsRemoveAppRulePayload {
  exe: string;
  gridId: string | null;
}

/**
 * Payload of `settings-set-prefs` (settings → brain, plan Task 18): the
 * General-card toggles. Routed to `setShellPrefs`; the persisted config then
 * drives Rust's autostart registration and hotkey re-bind. Pause is absent
 * here on purpose — its authority is the `set_paused` command, echoed back
 * via `paused-changed`.
 */
export interface SettingsSetPrefsPayload {
  hotkey?: string;
  autostart?: boolean;
}

// ---------------------------------------------------------------------------
// Commands (webview → Rust)
// ---------------------------------------------------------------------------

export function listWindows(): Promise<WindowInfo[]> {
  return invoke<WindowInfo[]>('list_windows');
}

export function listMonitors(): Promise<MonitorInfo[]> {
  return invoke<MonitorInfo[]>('list_monitors');
}

export function applyLayout(layout: ApplyLayout): Promise<void> {
  return invoke('apply_layout', { layout });
}

export function showOverlay(monitorId: string): Promise<void> {
  return invoke('show_overlay', { monitorId });
}

export function hideOverlay(monitorId: string): Promise<void> {
  return invoke('hide_overlay', { monitorId });
}

/**
 * Contract extension (critique fix, event-storm hardening): O(1) check
 * whether a hwnd is still in the tracker's live eligible set. The brain host
 * uses it to vet `window-destroyed` events against forgery without running a
 * full desktop sweep per event.
 */
export function windowIsTracked(hwnd: Hwnd): Promise<boolean> {
  return invoke<boolean>('window_is_tracked', { hwnd });
}

/**
 * Contract extension (critique round 2, brain-death coverage): the brain
 * host's heartbeat. Invoked every few seconds by a healthy brain page; a
 * Rust watchdog that misses enough beats destroys and respawns the brain
 * window (covering renderer crashes, boot failures and wedged event loops —
 * the deaths the `Destroyed` watchdog cannot see).
 */
export function brainAlive(): Promise<void> {
  return invoke('brain_alive');
}

export function readConfig(): Promise<AppConfig | null> {
  return invoke<AppConfig | null>('read_config');
}

export function writeConfig(config: AppConfig): Promise<void> {
  return invoke('write_config', { config });
}

export function setPaused(paused: boolean): Promise<void> {
  return invoke('set_paused', { paused });
}

export function focusWindow(hwnd: Hwnd): Promise<void> {
  return invoke('focus_window', { hwnd });
}

export function showSettings(): Promise<void> {
  return invoke('show_settings');
}

/**
 * Contract extension (plan Task 18): tell the tray which monitors currently
 * have an enabled grid so its per-monitor check items reflect live state.
 * The brain host calls this on every state snapshot. `floatingCount` (spec
 * §5.4) is the number of windows whose grid could not fit them — the tray
 * tooltip surfaces it as the grid-full hint.
 */
export function updateTray(
  enabledMonitorIds: string[],
  floatingCount = 0,
): Promise<void> {
  return invoke('update_tray', { enabledMonitorIds, floatingCount });
}

// ---------------------------------------------------------------------------
// Events Rust → webviews
// ---------------------------------------------------------------------------

function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

export function onWindowAppeared(cb: (w: WindowInfo) => void): Promise<UnlistenFn> {
  return on('window-appeared', cb);
}

export function onWindowDestroyed(cb: (p: HwndPayload) => void): Promise<UnlistenFn> {
  return on('window-destroyed', cb);
}

export function onWindowMinimized(cb: (p: HwndPayload) => void): Promise<UnlistenFn> {
  return on('window-minimized', cb);
}

export function onWindowRestored(cb: (w: WindowInfo) => void): Promise<UnlistenFn> {
  return on('window-restored', cb);
}

export function onMoveSizeStart(cb: (p: HwndPayload) => void): Promise<UnlistenFn> {
  return on('movesize-start', cb);
}

export function onDragPos(cb: (p: DragPos) => void): Promise<UnlistenFn> {
  return on('drag-pos', cb);
}

export function onMoveSizeEnd(cb: (p: MoveSizeEndPayload) => void): Promise<UnlistenFn> {
  return on('movesize-end', cb);
}

export function onMonitorsChanged(cb: (mons: MonitorInfo[]) => void): Promise<UnlistenFn> {
  return on('monitors-changed', cb);
}

export function onHotkeySettings(cb: () => void): Promise<UnlistenFn> {
  return on('hotkey-settings', () => cb());
}

export function onTrayToggleGrid(
  cb: (p: TrayToggleGridPayload) => void,
): Promise<UnlistenFn> {
  return on('tray-toggle-grid', cb);
}

export function onPausedChanged(cb: (paused: boolean) => void): Promise<UnlistenFn> {
  return on('paused-changed', cb);
}

// ---------------------------------------------------------------------------
// Events brain → overlays / settings (and back)
// ---------------------------------------------------------------------------

export function emitPreviewState(p: PreviewState): Promise<void> {
  return emit('preview-state', p);
}

export function onPreviewState(cb: (p: PreviewState) => void): Promise<UnlistenFn> {
  return on('preview-state', cb);
}

export function emitStateSnapshot(s: StateSnapshot): Promise<void> {
  return emit('state-snapshot', s);
}

export function onStateSnapshot(cb: (s: StateSnapshot) => void): Promise<UnlistenFn> {
  return on('state-snapshot', cb);
}

export function emitSettingsMove(p: SettingsMovePayload): Promise<void> {
  return emit('settings-move', p);
}

export function onSettingsMove(cb: (p: SettingsMovePayload) => void): Promise<UnlistenFn> {
  return on('settings-move', cb);
}

/** Settings window announces itself; the brain re-emits its last snapshot. */
export function emitSettingsReady(): Promise<void> {
  return emit('settings-ready', {});
}

export function onSettingsReady(cb: () => void): Promise<UnlistenFn> {
  return on('settings-ready', () => cb());
}

/**
 * Overlay webview announces itself once loaded; the brain re-emits its last
 * snapshot so the overlay learns its grid's dims/monitors (plan Task 15
 * contract extension).
 */
export function emitOverlayReady(): Promise<void> {
  return emit('overlay-ready', {});
}

export function onOverlayReady(cb: () => void): Promise<UnlistenFn> {
  return on('overlay-ready', () => cb());
}

export function emitSettingsEnableGrid(p: SettingsEnableGridPayload): Promise<void> {
  return emit('settings-enable-grid', p);
}

export function onSettingsEnableGrid(
  cb: (p: SettingsEnableGridPayload) => void,
): Promise<UnlistenFn> {
  return on('settings-enable-grid', cb);
}

export function emitSettingsDisableGrid(p: SettingsDisableGridPayload): Promise<void> {
  return emit('settings-disable-grid', p);
}

export function onSettingsDisableGrid(
  cb: (p: SettingsDisableGridPayload) => void,
): Promise<UnlistenFn> {
  return on('settings-disable-grid', cb);
}

export function emitSettingsEnableSpan(p: SettingsEnableSpanPayload): Promise<void> {
  return emit('settings-enable-span', p);
}

export function onSettingsEnableSpan(
  cb: (p: SettingsEnableSpanPayload) => void,
): Promise<UnlistenFn> {
  return on('settings-enable-span', cb);
}

export function emitSettingsSetDims(p: SettingsSetDimsPayload): Promise<void> {
  return emit('settings-set-dims', p);
}

export function onSettingsSetDims(
  cb: (p: SettingsSetDimsPayload) => void,
): Promise<UnlistenFn> {
  return on('settings-set-dims', cb);
}

export function emitSettingsSetMode(p: SettingsSetModePayload): Promise<void> {
  return emit('settings-set-mode', p);
}

export function onSettingsSetMode(
  cb: (p: SettingsSetModePayload) => void,
): Promise<UnlistenFn> {
  return on('settings-set-mode', cb);
}

export function emitSettingsSetSpacing(p: SettingsSetSpacingPayload): Promise<void> {
  return emit('settings-set-spacing', p);
}

export function onSettingsSetSpacing(
  cb: (p: SettingsSetSpacingPayload) => void,
): Promise<UnlistenFn> {
  return on('settings-set-spacing', cb);
}

export function emitSettingsCaptureTemplate(
  p: SettingsCaptureTemplatePayload,
): Promise<void> {
  return emit('settings-capture-template', p);
}

export function onSettingsCaptureTemplate(
  cb: (p: SettingsCaptureTemplatePayload) => void,
): Promise<UnlistenFn> {
  return on('settings-capture-template', cb);
}

export function emitSettingsApplyTemplate(
  p: SettingsApplyTemplatePayload,
): Promise<void> {
  return emit('settings-apply-template', p);
}

export function onSettingsApplyTemplate(
  cb: (p: SettingsApplyTemplatePayload) => void,
): Promise<UnlistenFn> {
  return on('settings-apply-template', cb);
}

export function emitSettingsDeleteTemplate(
  p: SettingsDeleteTemplatePayload,
): Promise<void> {
  return emit('settings-delete-template', p);
}

export function onSettingsDeleteTemplate(
  cb: (p: SettingsDeleteTemplatePayload) => void,
): Promise<UnlistenFn> {
  return on('settings-delete-template', cb);
}

export function emitSettingsSetExclusions(
  p: SettingsSetExclusionsPayload,
): Promise<void> {
  return emit('settings-set-exclusions', p);
}

export function onSettingsSetExclusions(
  cb: (p: SettingsSetExclusionsPayload) => void,
): Promise<UnlistenFn> {
  return on('settings-set-exclusions', cb);
}

export function emitSettingsSetAppRule(p: SettingsSetAppRulePayload): Promise<void> {
  return emit('settings-set-app-rule', p);
}

export function onSettingsSetAppRule(
  cb: (p: SettingsSetAppRulePayload) => void,
): Promise<UnlistenFn> {
  return on('settings-set-app-rule', cb);
}

export function emitSettingsRemoveAppRule(
  p: SettingsRemoveAppRulePayload,
): Promise<void> {
  return emit('settings-remove-app-rule', p);
}

export function onSettingsRemoveAppRule(
  cb: (p: SettingsRemoveAppRulePayload) => void,
): Promise<UnlistenFn> {
  return on('settings-remove-app-rule', cb);
}

export function emitSettingsSetPrefs(p: SettingsSetPrefsPayload): Promise<void> {
  return emit('settings-set-prefs', p);
}

export function onSettingsSetPrefs(
  cb: (p: SettingsSetPrefsPayload) => void,
): Promise<UnlistenFn> {
  return on('settings-set-prefs', cb);
}
