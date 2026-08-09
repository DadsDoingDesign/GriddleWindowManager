// Overlay view-model resolution (critique fix, spanning grids + overlay):
// an overlay window knows only its own monitor; the grid it must render is
// whatever *enabled* grid covers that monitor — per-monitor or spanning —
// never a stale disabled settings entry. Cell rects for a spanning grid are
// computed against the union monitor, so a span preview always produces a
// real footprint rect in every member overlay's view model.

import { describe, expect, it } from 'vitest';
import { cellRect } from '../src/coords';
import { resolveOverlayGrid, spanGridId, unionWorkArea } from '../src/spanning';
import type { GridSettings, MonitorInfo, Slot } from '../src/types';

const MON_A: MonitorInfo = {
  id: '\\\\.\\DISPLAY1@0,0',
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  workX: 0,
  workY: 48,
  workWidth: 1920,
  workHeight: 1032,
  dpi: 96,
  primary: true,
};
const MON_B: MonitorInfo = {
  id: '\\\\.\\DISPLAY2@1920,0',
  x: 1920,
  y: 0,
  width: 1600,
  height: 1080,
  workX: 1920,
  workY: 0,
  workWidth: 1600,
  workHeight: 1080,
  dpi: 96,
  primary: false,
};

function grid(overrides: Partial<GridSettings>): GridSettings {
  return {
    id: `grid:${MON_A.id}`,
    monitorIds: [MON_A.id],
    cols: 12,
    rows: 6,
    mode: 'collision',
    enabled: true,
    activeTemplateId: null,
    ...overrides,
  };
}

describe('resolveOverlayGrid', () => {
  it('resolves the per-monitor grid for its own monitor', () => {
    const view = resolveOverlayGrid([grid({})], [MON_A, MON_B], MON_A.id);
    expect(view).not.toBeNull();
    expect(view!.gridId).toBe(`grid:${MON_A.id}`);
    expect(view!.dims).toEqual({ cols: 12, rows: 6 });
    expect(view!.layoutMon).toEqual(MON_A);
  });

  it('resolves a spanning grid for every member monitor, against the union', () => {
    const spanId = spanGridId([MON_A.id, MON_B.id]);
    const span = grid({ id: spanId, monitorIds: [MON_A.id, MON_B.id], cols: 10, rows: 4 });
    for (const monitorId of [MON_A.id, MON_B.id]) {
      const view = resolveOverlayGrid([span], [MON_A, MON_B], monitorId);
      expect(view, `member ${monitorId}`).not.toBeNull();
      expect(view!.gridId).toBe(spanId);
      expect(view!.layoutMon).toEqual(unionWorkArea([MON_A, MON_B]));
    }
  });

  it('a span preview footprint yields a non-null cell rect in a member overlay view', () => {
    // The gate for the shipped bug: overlays hardcoded `grid:<monitorId>` and
    // never matched span previews, rendering nothing during spanning drags.
    const spanId = spanGridId([MON_A.id, MON_B.id]);
    const span = grid({ id: spanId, monitorIds: [MON_A.id, MON_B.id], cols: 10, rows: 4 });
    const view = resolveOverlayGrid([span], [MON_A, MON_B], MON_B.id)!;
    // Preview event as the brain emits it during a spanning drag:
    const preview = { gridId: spanId, visible: true, footprint: { col: 6, row: 1, w: 2, h: 2 } };
    expect(preview.gridId).toBe(view.gridId); // the overlay accepts it
    const r = cellRect(view.layoutMon, view.dims, preview.footprint as Slot);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    // Cols 6..8 of a 10-col union (3520 px wide work area) sit on MON_B.
    expect(r.x).toBeGreaterThanOrEqual(MON_B.workX);
  });

  it('ignores disabled grids — including the stale per-monitor entry a span replaced', () => {
    const spanId = spanGridId([MON_A.id, MON_B.id]);
    const stale = grid({ enabled: false, cols: 3, rows: 3 });
    const span = grid({ id: spanId, monitorIds: [MON_A.id, MON_B.id], cols: 10, rows: 4 });
    const view = resolveOverlayGrid([stale, span], [MON_A, MON_B], MON_A.id);
    expect(view!.gridId).toBe(spanId);
    expect(view!.dims).toEqual({ cols: 10, rows: 4 });
    expect(resolveOverlayGrid([stale], [MON_A, MON_B], MON_A.id)).toBeNull();
  });

  it('returns null when no grid covers the monitor or a span member is absent', () => {
    expect(resolveOverlayGrid([], [MON_A], MON_A.id)).toBeNull();
    expect(resolveOverlayGrid([grid({})], [MON_A], MON_B.id)).toBeNull();
    const spanId = spanGridId([MON_A.id, MON_B.id]);
    const span = grid({ id: spanId, monitorIds: [MON_A.id, MON_B.id] });
    // MON_B unplugged: the span is inert, its overlays render nothing.
    expect(resolveOverlayGrid([span], [MON_A], MON_A.id)).toBeNull();
  });
});
