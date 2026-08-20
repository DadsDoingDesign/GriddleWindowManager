// Persistence (spec §8, plan Task 7) — AppConfig (de)serialization plus
// validation of stored Grid.toJSON() layout snapshots. Pure: no fs and no
// Tauri imports; the host (config.rs / brain page) owns the actual disk IO.
//
// Philosophy: never throw on bad input. A config that is fundamentally not a
// config (bad JSON, wrong shape/version) parses to `null` so the caller can
// fall back to defaults; a config with *some* bad entries keeps every valid
// entry and drops the rest. Layout snapshots are validated separately at
// grid-enable time — a corrupt entry just means that grid starts empty.

import { MAX_SPACING_PX } from './coords';
import type {
  AppConfig,
  AppRule,
  GridSettings,
  PlacementMode,
  Slot,
  Template,
  View,
  ViewAssignment,
  ViewGrid,
} from './types';

export const DEFAULT_HOTKEY = 'Ctrl+Super+G';

/**
 * The placement mode a stored value means, or `null` if it means nothing.
 *
 * This is the whole v3 → v4 mode migration: `collision` and `overlay` are the
 * names v0.1.0/v0.2.0 wrote for what are now `push` and `stack`, so every
 * pre-existing config keeps the exact behavior it had — it just persists the
 * new spelling the next time it is written. Both loaders run it (here for
 * `sanitizeConfig`, and the brain's own constructor intake, because the
 * shipped read path is Rust serde straight into the constructor).
 */
export function normalizePlacementMode(raw: unknown): PlacementMode | null {
  switch (raw) {
    case 'reflow':
    case 'push':
    case 'stack':
      return raw;
    case 'collision':
      return 'push';
    case 'overlay':
      return 'stack';
    default:
      return null;
  }
}

export function defaultConfig(): AppConfig {
  return {
    version: 5,
    grids: [],
    templates: [],
    exclusions: [],
    layouts: {},
    hotkey: DEFAULT_HOTKEY,
    autostart: false,
    paused: false,
    appRules: [],
    views: [],
    startupViewId: null,
    // Opt-in, always (spec §7): a fresh install never reaches the network.
    autoCheckUpdates: false,
    // Opt-in likewise (spec 2026-08-19): a fresh install never edits the OS.
    suppressWindowsSnap: false,
    windowsSnapOriginal: null,
  };
}

function isSnapState(v: unknown): v is import('./types').SnapState {
  return (
    isRecord(v) &&
    typeof v.dockMoving === 'boolean' &&
    typeof v.snapSizing === 'boolean' &&
    typeof v.snapAssistFlyout === 'boolean'
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** A slot with integer fields, ≥1×1, fully inside a cols×rows grid. */
function sanitizeSlot(raw: unknown, cols: number, rows: number): Slot | null {
  if (!isRecord(raw)) return null;
  const { col, row, w, h } = raw;
  if (!isInt(col) || !isInt(row) || !isInt(w) || !isInt(h)) return null;
  if (w < 1 || h < 1 || col < 0 || row < 0) return null;
  if (col + w > cols || row + h > rows) return null;
  return { col, row, w, h };
}

/**
 * Spacing field migration (spec v0.2 §4 groundwork): a valid number is
 * clamped into the settings range (integer px, 0..64); anything else —
 * including the field being absent, as in every v1 config — reads as
 * `undefined`, which the whole stack treats as 0.
 */
function sanitizeSpacing(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(Math.floor(raw), 0), MAX_SPACING_PX);
}

function sanitizeGridSettings(raw: unknown): GridSettings | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (!Array.isArray(raw.monitorIds)) return null;
  const monitorIds = raw.monitorIds.filter(isNonEmptyString);
  if (monitorIds.length === 0) return null;
  if (!isInt(raw.cols) || !isInt(raw.rows) || raw.cols < 1 || raw.rows < 1) {
    return null;
  }
  const mode = normalizePlacementMode(raw.mode);
  if (mode === null) return null;
  const gap = sanitizeSpacing(raw.gap);
  const padding = sanitizeSpacing(raw.padding);
  return {
    id: raw.id,
    monitorIds,
    cols: raw.cols,
    rows: raw.rows,
    mode,
    enabled: raw.enabled === true,
    activeTemplateId: isNonEmptyString(raw.activeTemplateId)
      ? raw.activeTemplateId
      : null,
    // Emitted only when present so a v1 config round-trips byte-identical;
    // absent means 0 (spec v0.2 §1 defaults).
    ...(gap !== undefined ? { gap } : {}),
    ...(padding !== undefined ? { padding } : {}),
  };
}

function sanitizeTemplate(raw: unknown): Template | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id) || typeof raw.name !== 'string') return null;
  if (!isInt(raw.cols) || !isInt(raw.rows) || raw.cols < 1 || raw.rows < 1) {
    return null;
  }
  if (!Array.isArray(raw.slots)) return null;
  const slots: Slot[] = [];
  for (const s of raw.slots) {
    const slot = sanitizeSlot(s, raw.cols, raw.rows);
    if (slot === null) return null; // a template with any bad slot is useless
    slots.push(slot);
  }
  return {
    id: raw.id,
    name: raw.name,
    cols: raw.cols,
    rows: raw.rows,
    slots,
    builtin: raw.builtin === true,
  };
}

/**
 * App-rule validation (spec v0.2 §2). The slot only needs to be a sane
 * ≥1×1 integer rect at a non-negative origin — it is NOT bounded to any
 * grid's dims here, because the rule clamps into the target grid's *current*
 * dims when it fires. `gridId` must be null (any grid) or a non-empty
 * string; anything else drops the rule.
 */
function sanitizeAppRule(raw: unknown): AppRule | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.exe !== 'string') return null;
  const exe = raw.exe.trim().toLowerCase();
  if (exe.length === 0) return null;
  let gridId: string | null;
  if (raw.gridId === null || raw.gridId === undefined) {
    gridId = null;
  } else if (isNonEmptyString(raw.gridId)) {
    gridId = raw.gridId;
  } else {
    return null;
  }
  if (!isRecord(raw.slot)) return null;
  const { col, row, w, h } = raw.slot;
  if (!isInt(col) || !isInt(row) || !isInt(w) || !isInt(h)) return null;
  if (col < 0 || row < 0 || w < 1 || h < 1) return null;
  return { exe, gridId, slot: { col, row, w, h } };
}

/**
 * Assignment validation (spec v0.2 §3), same slot philosophy as app rules:
 * a sane ≥1×1 integer rect at a non-negative origin, NOT bounded to the
 * grid's dims — it clamps into the grid's *current* dims when claimed.
 */
function sanitizeViewAssignment(raw: unknown): ViewAssignment | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.exe !== 'string') return null;
  const exe = raw.exe.trim().toLowerCase();
  if (exe.length === 0) return null;
  if (!isRecord(raw.slot)) return null;
  const { col, row, w, h } = raw.slot;
  if (!isInt(col) || !isInt(row) || !isInt(w) || !isInt(h)) return null;
  if (col < 0 || row < 0 || w < 1 || h < 1) return null;
  return { exe, slot: { col, row, w, h } };
}

/**
 * View validation (spec v0.2 §3). A view with a bad id/name/grids shape is
 * dropped whole; inside a valid view, malformed grids and assignments are
 * dropped individually (keep-every-valid-entry philosophy). Duplicate grid
 * ids within one view keep the first.
 */
function sanitizeView(raw: unknown): View | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name)) return null;
  if (!Array.isArray(raw.grids)) return null;
  const grids: ViewGrid[] = [];
  const gridIds = new Set<string>();
  for (const g of raw.grids) {
    if (!isRecord(g)) continue;
    const settings = sanitizeGridSettings(g.settings);
    if (settings === null || gridIds.has(settings.id)) continue;
    const assignments: ViewAssignment[] = [];
    if (Array.isArray(g.assignments)) {
      for (const a of g.assignments) {
        const asg = sanitizeViewAssignment(a);
        if (asg !== null) assignments.push(asg);
      }
    }
    gridIds.add(settings.id);
    grids.push({ settings, assignments });
  }
  return { id: raw.id, name: raw.name, grids };
}

/**
 * Structural validation of a parsed config value. Returns `null` when the
 * value is not an AppConfig at all (not an object / unsupported version);
 * otherwise returns a config with every invalid grid/template/exclusion
 * entry dropped and missing scalars defaulted. Never throws.
 *
 * Versions: v4 is current (placement modes). A v1 config (written by v0.1.0),
 * a v2 one (v0.2.0) or a v3 one migrates in place — `appRules: [], views: [],
 * startupViewId: null, autoCheckUpdates: false`, spacing fields absent
 * (absent means 0), and `mode: 'collision'|'overlay'` rewritten to
 * `'push'|'stack'` (same behavior, new name). Unknown future versions return
 * `null`, which the host treats as corrupt (`.bak` + fresh start).
 */
export function sanitizeConfig(raw: unknown): AppConfig | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.version !== 'number') return null;
  if (raw.version < 1 || raw.version > 5 || !Number.isInteger(raw.version)) {
    return null;
  }

  const grids: GridSettings[] = [];
  const gridIds = new Set<string>();
  if (Array.isArray(raw.grids)) {
    for (const g of raw.grids) {
      const grid = sanitizeGridSettings(g);
      if (grid && !gridIds.has(grid.id)) {
        gridIds.add(grid.id);
        grids.push(grid);
      }
    }
  }

  const templates: Template[] = [];
  const templateIds = new Set<string>();
  if (Array.isArray(raw.templates)) {
    for (const t of raw.templates) {
      const tpl = sanitizeTemplate(t);
      if (tpl && !templateIds.has(tpl.id)) {
        templateIds.add(tpl.id);
        templates.push(tpl);
      }
    }
  }

  const exclusions: string[] = [];
  if (Array.isArray(raw.exclusions)) {
    for (const e of raw.exclusions) {
      if (!isNonEmptyString(e)) continue;
      const exe = e.toLowerCase();
      if (!exclusions.includes(exe)) exclusions.push(exe);
    }
  }

  // One rule per (exe, gridId): duplicates keep the first, like grids and
  // templates. Absent in a v1 config → migrates to [] (spec v0.2 §4).
  const appRules: AppRule[] = [];
  if (Array.isArray(raw.appRules)) {
    const ruleKeys = new Set<string>();
    for (const r of raw.appRules) {
      const rule = sanitizeAppRule(r);
      if (rule === null) continue;
      const key = `${rule.exe}\n${rule.gridId ?? ''}`;
      if (ruleKeys.has(key)) continue;
      ruleKeys.add(key);
      appRules.push(rule);
    }
  }

  // Startup views (spec v0.2 §3/§4). Duplicate ids keep the first; a
  // startupViewId pointing at no surviving view resets to null.
  const views: View[] = [];
  const viewIds = new Set<string>();
  if (Array.isArray(raw.views)) {
    for (const v of raw.views) {
      const view = sanitizeView(v);
      if (view !== null && !viewIds.has(view.id)) {
        viewIds.add(view.id);
        views.push(view);
      }
    }
  }
  const startupViewId =
    isNonEmptyString(raw.startupViewId) && viewIds.has(raw.startupViewId)
      ? raw.startupViewId
      : null;

  return {
    version: 5,
    grids,
    templates,
    exclusions,
    // Entries are opaque Grid.toJSON() blobs here; they get validated by
    // extractLayoutTiles when a grid actually loads them.
    layouts: isRecord(raw.layouts) ? { ...raw.layouts } : {},
    hotkey: isNonEmptyString(raw.hotkey) ? raw.hotkey : DEFAULT_HOTKEY,
    autostart: raw.autostart === true,
    paused: raw.paused === true,
    appRules,
    views,
    startupViewId,
    // Anything other than a literal `true` — including the field being
    // absent, as in every v1/v2 config — reads as opted out (spec §7).
    autoCheckUpdates: raw.autoCheckUpdates === true,
    // Same opt-in rule (spec 2026-08-19); the capture is Rust-authoritative
    // and merely round-trips, so shape-validate it and otherwise pass along.
    suppressWindowsSnap: raw.suppressWindowsSnap === true,
    windowsSnapOriginal: isSnapState(raw.windowsSnapOriginal) ? raw.windowsSnapOriginal : null,
  };
}

/** Parse config.json text. Corrupt JSON or a non-config shape → `null`. */
export function parseConfig(text: string): AppConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return sanitizeConfig(raw);
}

/** Serialize for config.json (pretty, trailing newline, atomic-write ready). */
export function serializeConfig(cfg: AppConfig): string {
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** One tile recovered from a stored layout snapshot. */
export interface StoredTile {
  id: string;
  slot: Slot;
  absolute: boolean;
}

/**
 * Validate an `AppConfig.layouts` entry (a `Grid.toJSON()` snapshot) and
 * extract its tiles. Returns `null` when the snapshot as a whole is corrupt
 * or missing; individually malformed or duplicate tiles are skipped. Slot
 * bounds are NOT checked here — the loading grid's dims may have changed, so
 * the brain re-validates each slot against the live grid.
 */
export function extractLayoutTiles(raw: unknown): StoredTile[] | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.tiles)) {
    return null;
  }
  const out: StoredTile[] = [];
  const seen = new Set<string>();
  for (const t of raw.tiles) {
    if (!isRecord(t)) continue;
    if (!isNonEmptyString(t.id) || seen.has(t.id)) continue;
    if (!isInt(t.w) || !isInt(t.h) || t.w < 1 || t.h < 1) continue;
    const position = t.position ?? 'static';
    let col: number;
    let row: number;
    let absolute: boolean;
    if (
      position === 'absolute' &&
      isRecord(t.pinned) &&
      isInt(t.pinned.x) &&
      isInt(t.pinned.y)
    ) {
      col = t.pinned.x;
      row = t.pinned.y;
      absolute = true;
    } else if (position === 'static' && isInt(t.col) && isInt(t.row)) {
      col = t.col;
      row = t.row;
      absolute = false;
    } else {
      continue; // fixed/relative/sticky or malformed — the brain never writes these
    }
    if (col < 0 || row < 0) continue;
    seen.add(t.id);
    out.push({ id: t.id, slot: { col, row, w: t.w, h: t.h }, absolute });
  }
  return out;
}
