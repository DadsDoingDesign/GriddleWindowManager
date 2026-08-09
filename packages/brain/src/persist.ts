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
import type { AppConfig, GridSettings, Slot, Template } from './types';

export const DEFAULT_HOTKEY = 'Ctrl+Super+G';

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    grids: [],
    templates: [],
    exclusions: [],
    layouts: {},
    hotkey: DEFAULT_HOTKEY,
    autostart: false,
    paused: false,
  };
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
  if (raw.mode !== 'collision' && raw.mode !== 'overlay') return null;
  const gap = sanitizeSpacing(raw.gap);
  const padding = sanitizeSpacing(raw.padding);
  return {
    id: raw.id,
    monitorIds,
    cols: raw.cols,
    rows: raw.rows,
    mode: raw.mode,
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
 * Structural validation of a parsed config value. Returns `null` when the
 * value is not an AppConfig at all (not an object / unsupported version);
 * otherwise returns a config with every invalid grid/template/exclusion
 * entry dropped and missing scalars defaulted. Never throws.
 */
export function sanitizeConfig(raw: unknown): AppConfig | null {
  if (!isRecord(raw) || raw.version !== 1) return null;

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

  return {
    version: 1,
    grids,
    templates,
    exclusions,
    // Entries are opaque Grid.toJSON() blobs here; they get validated by
    // extractLayoutTiles when a grid actually loads them.
    layouts: isRecord(raw.layouts) ? { ...raw.layouts } : {},
    hotkey: isNonEmptyString(raw.hotkey) ? raw.hotkey : DEFAULT_HOTKEY,
    autostart: raw.autostart === true,
    paused: raw.paused === true,
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
