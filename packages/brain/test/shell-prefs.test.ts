// Plan Task 18 — contract C3 extension `setShellPrefs`: pause mirroring
// (Rust's paused-changed events), the autostart toggle and the hotkey rebind,
// all persisting through exportConfig and re-emitting the snapshot exactly
// when something actually changed.

import { describe, expect, it } from 'vitest';
import { WindowManagerBrain, defaultConfig } from '../src';
import type { StateSnapshot } from '../src';

function makeBrain(cfg = defaultConfig()) {
  const snapshots: StateSnapshot[] = [];
  const brain = new WindowManagerBrain(
    {
      onApply: () => {},
      onPreview: () => {},
      onSnapshot: (s) => snapshots.push(s),
    },
    cfg,
  );
  return { brain, snapshots };
}

describe('setShellPrefs (contract C3 extension, Task 18)', () => {
  it('mirrors a pause change into config and snapshot', () => {
    const { brain, snapshots } = makeBrain();
    brain.setShellPrefs({ paused: true });
    expect(brain.exportConfig().paused).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.paused).toBe(true);

    brain.setShellPrefs({ paused: false });
    expect(brain.exportConfig().paused).toBe(false);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.paused).toBe(false);
  });

  it('updates autostart and hotkey into exportConfig', () => {
    const { brain, snapshots } = makeBrain();
    brain.setShellPrefs({ autostart: true, hotkey: 'Ctrl+Alt+G' });
    const cfg = brain.exportConfig();
    expect(cfg.autostart).toBe(true);
    expect(cfg.hotkey).toBe('Ctrl+Alt+G');
    expect(snapshots).toHaveLength(1);
  });

  it('suppressWindowsSnap round-trips and only fires on change (spec 2026-08-19)', () => {
    const { brain, snapshots } = makeBrain();
    expect(brain.exportConfig().suppressWindowsSnap).toBe(false);

    brain.setShellPrefs({ suppressWindowsSnap: true });
    expect(brain.exportConfig().suppressWindowsSnap).toBe(true);
    expect(snapshots).toHaveLength(1);

    brain.setShellPrefs({ suppressWindowsSnap: true }); // no-op
    expect(snapshots).toHaveLength(1);

    brain.setShellPrefs({ suppressWindowsSnap: false });
    expect(brain.exportConfig().suppressWindowsSnap).toBe(false);
    expect(snapshots).toHaveLength(2);

    // The capture is Rust-authoritative: the brain merely echoes what the
    // config carried, and setShellPrefs cannot invent one.
    expect(brain.exportConfig().windowsSnapOriginal).toBeNull();
  });

  it('no-op updates emit no snapshot', () => {
    const { brain, snapshots } = makeBrain();
    brain.setShellPrefs({}); // nothing at all
    brain.setShellPrefs({ paused: false }); // already false
    brain.setShellPrefs({ autostart: false }); // already false
    brain.setShellPrefs({ hotkey: defaultConfig().hotkey }); // already default
    expect(snapshots).toHaveLength(0);
  });

  it('ignores an empty hotkey', () => {
    const { brain, snapshots } = makeBrain();
    brain.setShellPrefs({ hotkey: '' });
    expect(brain.exportConfig().hotkey).toBe(defaultConfig().hotkey);
    expect(snapshots).toHaveLength(0);
  });

  it('partial updates leave the other prefs untouched', () => {
    const { brain } = makeBrain();
    brain.setShellPrefs({ autostart: true });
    brain.setShellPrefs({ paused: true });
    brain.setShellPrefs({ hotkey: 'Super+G' });
    const cfg = brain.exportConfig();
    expect(cfg).toMatchObject({ autostart: true, paused: true, hotkey: 'Super+G' });
  });

  it('round-trips through a config reload (persistence)', () => {
    const { brain } = makeBrain();
    brain.setShellPrefs({ paused: true, autostart: true, hotkey: 'Ctrl+Shift+F1' });
    const { brain: reloaded } = makeBrain(brain.exportConfig());
    const cfg = reloaded.exportConfig();
    expect(cfg.paused).toBe(true);
    expect(cfg.autostart).toBe(true);
    expect(cfg.hotkey).toBe('Ctrl+Shift+F1');
  });
});
