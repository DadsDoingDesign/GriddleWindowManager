// Evals plan §2 (docs/evals-plan.md): the shared config corpus. One real
// file per schema version, as that version's writer produced it, living in
// fixtures/configs/ at the repo root — the SAME files the Rust loader's
// suite parses. A schema change that breaks either loader on any historical
// file fails here, which is the cross-language drift the type checkers
// cannot see.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WindowManagerBrain } from '../src/brain';
import { CONFIG_VERSION, parseConfig, serializeConfig } from '../src/persist';

const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'configs',
);

function fixture(name: string): string {
  return readFileSync(join(CORPUS_DIR, name), 'utf8');
}

describe('config corpus (shared with the Rust loader)', () => {
  it('has one fixture per schema version, none missing', () => {
    const names = readdirSync(CORPUS_DIR).filter((n) => n.endsWith('.json')).sort();
    const expected = Array.from(
      { length: CONFIG_VERSION },
      (_, i) => `v${i + 1}.json`,
    ).sort();
    expect(names).toEqual(expected);
  });

  for (let v = 1; v <= CONFIG_VERSION; v++) {
    it(`v${v} parses, re-stamps to v${CONFIG_VERSION}, and re-serializes stably`, () => {
      const cfg = parseConfig(fixture(`v${v}.json`));
      expect(cfg).not.toBeNull();
      expect(cfg!.version).toBe(CONFIG_VERSION);
      // Idempotence: what we write back must parse to the same value —
      // a migration that only works once is a migration that loses data
      // on the second boot.
      expect(parseConfig(serializeConfig(cfg!))).toEqual(cfg);
      // The constructor path (the shipped Rust-serde read feeds it raw)
      // must accept every historical file without throwing, and export a
      // current-version config.
      const brain = new WindowManagerBrain(
        { onApply: () => {}, onPreview: () => {}, onSnapshot: () => {} },
        cfg!,
      );
      expect(brain.exportConfig().version).toBe(CONFIG_VERSION);
    });
  }

  it('v1 keeps its exact behavior under the new names', () => {
    const cfg = parseConfig(fixture('v1.json'))!;
    // The two original modes, renamed — never re-interpreted.
    expect(cfg.grids.map((g) => g.mode)).toEqual(['push', 'stack']);
    // Every later field lands on its documented default.
    expect(cfg.appRules).toEqual([]);
    expect(cfg.views).toEqual([]);
    expect(cfg.startupViewId).toBeNull();
    expect(cfg.autoCheckUpdates).toBe(false);
    expect(cfg.suppressWindowsSnap).toBe(false);
    expect(cfg.manageSettingsWindow).toBe(false);
    expect(cfg.theme).toBeNull();
    expect(cfg.dropPlacement).toBe('fill');
    expect(cfg.movePlacement).toBe('size');
    expect(cfg.maximizeBehavior).toBe('expand');
    expect(cfg.noRoomPlacement).toBe('split');
    // The layout snapshot rides along untouched for the grid to validate.
    expect(Object.keys(cfg.layouts)).toHaveLength(1);
  });

  it('v9 round-trips its non-default choices verbatim', () => {
    const cfg = parseConfig(fixture('v9.json'))!;
    expect(cfg.dropPlacement).toBe('size');
    expect(cfg.movePlacement).toBe('fill');
    expect(cfg.maximizeBehavior).toBe('windows');
    expect(cfg.noRoomPlacement).toBe('refuse');
    expect(cfg.theme).toBe('light');
    expect(cfg.suppressWindowsSnap).toBe(true);
  });
});
