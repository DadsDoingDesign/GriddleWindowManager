# Griddle WM — Spacing, App Rules, and Startup Views (v0.2.0)

**Date:** 2026-08-09 · **Extends:** 2026-08-08-griddle-window-manager-design.md

## 1. Spacing (gap + padding)

- `GridSettings` gains `gap: number` and `padding: number` (physical px, defaults 0, range 0–64, stepper UI on each monitor/span card; persisted).
- **Padding** insets the usable area: effective work area = monitor work area shrunk by `padding` on all four sides (brain-side only).
- **Gap** is the spacing between adjacent cells. Cell math (brain `coords.ts`):
  `unitW = (effWidth - gap*(cols-1)) / cols`; `rect.x = effX + col*(unitW+gap)`; a `w`-cell footprint spans `w*unitW + (w-1)*gap` (interior gaps belong to the tile's rect so neighbors stay `gap` apart). Same for rows. Floor-accumulate rounding keeps the last column/row flush.
- The settings editor passes the same `gap` to Griddle's `config.gap` so the editor preview visually matches reality; overlay grid-line rendering accounts for gap/padding.
- Changing either value live re-applies the grid in one batch.

## 2. Per-app default placement (App Rules)

- New entity: `AppRule { exe: string; gridId: string | null; slot: Slot }` (`gridId: null` = any grid; exe lowercase basename). One rule per (exe, gridId); saving again overwrites.
- **Creation:** right-click a tile in the settings editor → context menu: "Save as default for <exe> on this grid" / "…on all grids" / "Remove default for <exe>" (shown only if one exists). Rules list (exe, scope, slot, delete) in a settings card.
- **Placement precedence** (extends spec §5.4): restore-previous-tile → **matching app rule** (grid-specific beats any-grid; slot clamped to current dims; if occupied in collision mode, `addTileWithDisplacement` at the rule slot) → active-template empty slot → auto-place.
- Rules apply on `windowAppeared` only (not to already-managed windows when a rule is created).

## 3. Startup Views

- New entity: `View { id: string; name: string; grids: ViewGrid[] }`, `ViewGrid { settings: GridSettings; assignments: Array<{ exe: string; slot: Slot }> }`. Views capture **exes, not hwnds** (reboot-safe). Multi-instance apps: first-come-first-claimed per assignment slot.
- **Capture:** settings → "Save current as view…" (names it; snapshots every enabled grid's settings incl. gap/padding and each tiled window's exe+slot).
- **Apply now:** reconfigures grids to the view's settings, then re-places current windows: assignment match by exe → its slot; unmatched windows auto-place.
- **Startup view:** `AppConfig.startupViewId: string | null`. On app launch (works with autostart): apply the view's grid settings immediately; register its assignments as **pending claims** for 120 s (configurable constant) — each `windowAppeared` matching an unclaimed exe assignment takes that slot (beats app rules in precedence during the window). After timeout or all-claimed, normal rules resume. Manual "Apply now" uses the same claim mechanism with the same timeout for windows that appear during it.
- Views card in settings: list, apply, rename, delete, "load at startup" radio (or none).

## 4. Persistence & migration

- `AppConfig.version: 2` — adds `appRules: AppRule[]`, `views: View[]`, `startupViewId: string | null`; `GridSettings` gains `gap`/`padding`. Loader migrates v1 → v2 (defaults: `gap:0, padding:0, appRules:[], views:[], startupViewId:null`); unknown future versions → `.bak` + fresh start (existing behavior).

## 5. Quality bar

- Vitest: gap/padding math (incl. rounding at odd resolutions, gap+padding+footprint interplay, clamping when `gap*(cols-1) ≥ effWidth` → gap coerced down to keep unitW ≥ 16px), rule precedence matrix, view capture/apply round-trip, claim expiry, v1→v2 migration.
- Fuzz suite extended: random gap/padding per grid; invariants unchanged (no overlap of *rects* in collision mode — rect-level check now that gaps exist, in-bounds incl. padding).
- Existing 201 TS + 120 Rust tests stay green. Critique pass on the new UI copy + IA. Installer rebuilt as v0.2.0.
