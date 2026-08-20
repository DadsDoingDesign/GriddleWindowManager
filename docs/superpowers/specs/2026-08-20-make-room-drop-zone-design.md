# Make-room drop zone — Design Spec

**Date:** 2026-08-20
**Status:** Approved (user chose split-under-cursor)

## 1. The gesture

A grid is full, the user drags a window over it, the overlay refuses ("No
room — this grid is full"). As of this spec the refusal is not a dead end: a
**drop-zone pill** appears at the refused footprint — "Drop here to make
room". Releasing while the cursor is inside the pill splits the tile the
user is aiming at and gives the newcomer the donated half. Releasing
anywhere else keeps the refusal exactly as before: making room is opt-in,
per drop, by aim.

The pill tracks the footprint (which tracks the cursor), so the "tile under
the cursor" and the "tile under the pill" are the same tile — the user's aim
picks the victim, not a heuristic.

## 2. Split semantics (split-under-cursor)

- **Victim**: the in-flow tile covering the refused footprint's origin cell.
- **Splittable** iff the victim spans ≥ 2 cells on some axis. A 1×1 victim
  cannot donate — the pill simply does not appear, and the plain refusal
  stands.
- **Split axis**: the victim's longer axis (tie → columns).
- **Donated half**: the half containing the aimed cell, so the newcomer
  lands where the user pointed; the victim keeps the other half. Odd spans
  round in the newcomer's favour on the aimed side.
- Commit goes through the same wholesale snapshot/restore the reflow commit
  uses: victim resized and newcomer added in one batch, one flush, one
  snapshot — never a half-applied grid.

## 3. WYSIWYG, as everywhere else

While the cursor hovers the pill (**armed**), the preview shows the actual
outcome: the footprint becomes the donated half and the victim's move is
drawn as a ghost, with the message switching to "Release to make room".
Un-armed, the grey refused footprint and "No room" message stay. The armed
preview and the drop commit run the same pure computation, so what is shown
is what happens.

## 4. Contract

`PreviewState` gains `makeRoom?: { x, y, width, height, armed }` — the
pill's rect in physical virtual-desktop pixels plus its hover state. Present
exactly when the placement is refused and a splittable victim exists. The
overlay renders it; the brain hit-tests the cursor against it on every drag
sample and at the drop.

## 5. Scope

Intake drags (the reported scenario: a floating window dragged onto a full
grid). Managed cross-grid transfers keep their existing fallback for now —
extending make-room to them is mechanical once this shape proves out.

## 6. Tests (vitest, brain)

- Pill present exactly when refused and the victim is splittable.
- No pill over a 1×1 victim; plain refusal preserved.
- `armed` follows the cursor in and out of the pill rect.
- Armed drop: victim shrunk to its kept half, newcomer tiled on the donated
  half, floating cleared, one apply.
- Un-armed drop: unchanged refusal behaviour (window stays floating).
- Armed preview ghosts the victim's kept half before any commit.
