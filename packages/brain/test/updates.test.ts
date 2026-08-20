// Opt-in update checks (spec §7 "Update checks"): the pure state machine the
// brain host drives, the AppConfig v2 → v3 migration that carries the toggle,
// and the guarantee the whole feature stands on — **off means no network**.

import { describe, expect, it } from 'vitest';
import {
  UPDATE_CHECK_INTERVAL_MS,
  WindowManagerBrain,
  canCheckNow,
  canInstall,
  defaultConfig,
  downloadFraction,
  initialUpdateState,
  parseConfig,
  sanitizeConfig,
  serializeConfig,
  shouldAutoCheck,
  updateReducer,
  type StateSnapshot,
  type UpdateEvent,
  type UpdateState,
} from '../src';

const T0 = 1_700_000_000_000;

/** Fold a list of events over the initial state. */
function run(...events: UpdateEvent[]): UpdateState {
  return events.reduce(updateReducer, initialUpdateState());
}

const foundV3: UpdateEvent = {
  type: 'check-found',
  version: '0.3.0',
  notes: 'Keyboard tiling commands.',
  date: '2026-09-01',
  at: T0,
};

function makeBrain(cfg = defaultConfig()) {
  const snapshots: StateSnapshot[] = [];
  const brain = new WindowManagerBrain(
    { onApply: () => {}, onPreview: () => {}, onSnapshot: (s) => snapshots.push(s) },
    cfg,
  );
  return { brain, snapshots };
}

describe('update state machine — happy path', () => {
  it('starts idle, knowing nothing', () => {
    const s = initialUpdateState();
    expect(s.phase).toBe('idle');
    expect(s.version).toBeNull();
    expect(s.lastCheckedAt).toBeNull();
    expect(s.upToDate).toBe(false);
    expect(s.error).toBe('');
  });

  it('idle → checking → available carries version, notes and date', () => {
    const s = run({ type: 'check-started' }, foundV3);
    expect(s.phase).toBe('available');
    expect(s.version).toBe('0.3.0');
    expect(s.notes).toBe('Keyboard tiling commands.');
    expect(s.date).toBe('2026-09-01');
    expect(s.lastCheckedAt).toBe(T0);
    expect(canInstall(s)).toBe(true);
  });

  it('a check that finds nothing lands back on idle, marked up to date', () => {
    const s = run({ type: 'check-started' }, { type: 'check-none', at: T0 });
    expect(s.phase).toBe('idle');
    expect(s.upToDate).toBe(true);
    expect(s.lastCheckedAt).toBe(T0);
    expect(s.version).toBeNull();
    expect(canInstall(s)).toBe(false);
  });

  it('download accumulates progress and then flips to installing', () => {
    let s = run({ type: 'check-started' }, foundV3, { type: 'download-started' });
    expect(s.phase).toBe('downloading');
    // The length is unknown until the transfer's first event reports it.
    expect(downloadFraction(s)).toBeNull();
    s = updateReducer(s, { type: 'download-total', total: 1000 });
    expect(downloadFraction(s)).toBe(0);

    s = updateReducer(s, { type: 'download-progress', chunk: 250 });
    s = updateReducer(s, { type: 'download-progress', chunk: 250 });
    expect(s.downloaded).toBe(500);
    expect(downloadFraction(s)).toBe(0.5);
    expect(s.installing).toBe(false);

    s = updateReducer(s, { type: 'install-started' });
    expect(s.phase).toBe('downloading');
    expect(s.installing).toBe(true);
  });

  it('reports an indeterminate download when the server sent no length', () => {
    let s = run({ type: 'check-started' }, foundV3, { type: 'download-started' });
    expect(s.total).toBeNull();
    expect(downloadFraction(s)).toBeNull();
    // A zero/absent content length must not masquerade as "0 of 0 done".
    s = updateReducer(s, { type: 'download-total', total: 0 });
    expect(downloadFraction(s)).toBeNull();
  });

  it('caps the reported fraction at 1 and ignores nonsense chunk sizes', () => {
    let s = run({ type: 'check-started' }, foundV3, { type: 'download-started' });
    s = updateReducer(s, { type: 'download-total', total: 100 });
    s = updateReducer(s, { type: 'download-progress', chunk: -50 });
    s = updateReducer(s, { type: 'download-progress', chunk: Number.NaN });
    expect(s.downloaded).toBe(0);
    s = updateReducer(s, { type: 'download-progress', chunk: 500 });
    expect(downloadFraction(s)).toBe(1);
  });
});

describe('update state machine — failures and dismissal', () => {
  it('a failed check surfaces the message and still records the attempt', () => {
    const s = run(
      { type: 'check-started' },
      { type: 'check-failed', message: 'network unreachable', at: T0 },
    );
    expect(s.phase).toBe('error');
    expect(s.error).toBe('network unreachable');
    expect(s.lastCheckedAt).toBe(T0);
    expect(s.upToDate).toBe(false);
  });

  it('a failed download keeps the version so the user can retry the offer', () => {
    const s = run({ type: 'check-started' }, foundV3, { type: 'download-started' }, {
      type: 'download-failed',
      message: 'signature mismatch',
    });
    expect(s.phase).toBe('error');
    expect(s.version).toBe('0.3.0');
    expect(s.installing).toBe(false);
    expect(s.error).toBe('signature mismatch');
  });

  it('dismiss clears an offer and an error, but never a live download', () => {
    const offered = run({ type: 'check-started' }, foundV3);
    expect(updateReducer(offered, { type: 'dismiss' }).phase).toBe('idle');
    expect(updateReducer(offered, { type: 'dismiss' }).version).toBeNull();

    const failed = run(
      { type: 'check-started' },
      { type: 'check-failed', message: 'boom', at: T0 },
    );
    const cleared = updateReducer(failed, { type: 'dismiss' });
    expect(cleared.phase).toBe('idle');
    expect(cleared.error).toBe('');
    // The attempt itself is not forgotten — the card still says when.
    expect(cleared.lastCheckedAt).toBe(T0);

    const downloading = run({ type: 'check-started' }, foundV3, {
      type: 'download-started',
    });
    expect(updateReducer(downloading, { type: 'dismiss' })).toBe(downloading);
  });

  it('a new check clears a stale up-to-date verdict', () => {
    const s = run(
      { type: 'check-started' },
      { type: 'check-none', at: T0 },
      { type: 'check-started' },
    );
    expect(s.phase).toBe('checking');
    expect(s.upToDate).toBe(false);
  });
});

describe('update state machine — out-of-phase events are ignored', () => {
  it('never starts a second check or interrupts a download', () => {
    const checking = run({ type: 'check-started' });
    expect(updateReducer(checking, { type: 'check-started' })).toBe(checking);

    const downloading = run({ type: 'check-started' }, foundV3, {
      type: 'download-started',
    });
    expect(updateReducer(downloading, { type: 'check-started' })).toBe(downloading);
  });

  it('ignores check results that arrive after the phase moved on', () => {
    const idle = initialUpdateState();
    for (const ev of [
      foundV3,
      { type: 'check-none', at: T0 } as const,
      { type: 'check-failed', message: 'late', at: T0 } as const,
    ]) {
      expect(updateReducer(idle, ev)).toBe(idle);
    }
  });

  it('never downloads without an offer, and never progresses without a download', () => {
    const idle = initialUpdateState();
    expect(updateReducer(idle, { type: 'download-started' })).toBe(idle);
    expect(updateReducer(idle, { type: 'download-progress', chunk: 10 })).toBe(idle);
    expect(updateReducer(idle, { type: 'install-started' })).toBe(idle);
    expect(updateReducer(idle, { type: 'download-failed', message: 'x' })).toBe(idle);

    const offered = run({ type: 'check-started' }, foundV3);
    expect(updateReducer(offered, { type: 'download-progress', chunk: 10 })).toBe(offered);
    expect(updateReducer(offered, { type: 'download-total', total: 10 })).toBe(offered);
    expect(updateReducer(offered, { type: 'install-started' })).toBe(offered);
  });
});

describe('off means no network call (spec §7 guarantee)', () => {
  it('shouldAutoCheck is false for every state while the toggle is off', () => {
    const states: UpdateState[] = [
      initialUpdateState(),
      run({ type: 'check-started' }),
      run({ type: 'check-started' }, foundV3),
      run({ type: 'check-started' }, { type: 'check-none', at: T0 }),
      run({ type: 'check-started' }, { type: 'check-failed', message: 'x', at: T0 }),
      run({ type: 'check-started' }, foundV3, { type: 'download-started' }),
    ];
    for (const now of [0, T0, T0 + UPDATE_CHECK_INTERVAL_MS * 365]) {
      for (const state of states) {
        expect(shouldAutoCheck(state, { enabled: false, now })).toBe(false);
      }
    }
  });

  it('a default config is opted out, so a fresh install never checks', () => {
    const cfg = defaultConfig();
    expect(cfg.autoCheckUpdates).toBe(false);
    expect(
      shouldAutoCheck(initialUpdateState(), {
        enabled: cfg.autoCheckUpdates,
        now: T0,
      }),
    ).toBe(false);
  });

  it('"Check now" stays available while opted out — the click is the consent', () => {
    expect(canCheckNow(initialUpdateState())).toBe(true);
    expect(canCheckNow(run({ type: 'check-started' }, { type: 'check-none', at: T0 }))).toBe(
      true,
    );
  });

  it('"Check now" is blocked only while a check or download is in flight', () => {
    expect(canCheckNow(run({ type: 'check-started' }))).toBe(false);
    expect(
      canCheckNow(run({ type: 'check-started' }, foundV3, { type: 'download-started' })),
    ).toBe(false);
    expect(canCheckNow(run({ type: 'check-started' }, foundV3))).toBe(true);
  });
});

describe('auto-check cadence (opted in)', () => {
  it('checks once at launch, then once per interval', () => {
    const fresh = initialUpdateState();
    expect(shouldAutoCheck(fresh, { enabled: true, now: T0 })).toBe(true);

    const checked = run({ type: 'check-started' }, { type: 'check-none', at: T0 });
    expect(shouldAutoCheck(checked, { enabled: true, now: T0 })).toBe(false);
    expect(
      shouldAutoCheck(checked, { enabled: true, now: T0 + UPDATE_CHECK_INTERVAL_MS - 1 }),
    ).toBe(false);
    expect(
      shouldAutoCheck(checked, { enabled: true, now: T0 + UPDATE_CHECK_INTERVAL_MS }),
    ).toBe(true);
  });

  it('the interval is 24 hours', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(86_400_000);
  });

  it('re-checks after a failure once the interval has passed', () => {
    const failed = run(
      { type: 'check-started' },
      { type: 'check-failed', message: 'offline', at: T0 },
    );
    expect(shouldAutoCheck(failed, { enabled: true, now: T0 + 1000 })).toBe(false);
    expect(
      shouldAutoCheck(failed, { enabled: true, now: T0 + UPDATE_CHECK_INTERVAL_MS }),
    ).toBe(true);
  });

  it('never re-checks while checking, downloading, or already holding an offer', () => {
    const later = T0 + UPDATE_CHECK_INTERVAL_MS * 10;
    for (const state of [
      run({ type: 'check-started' }),
      run({ type: 'check-started' }, foundV3),
      run({ type: 'check-started' }, foundV3, { type: 'download-started' }),
    ]) {
      expect(shouldAutoCheck(state, { enabled: true, now: later })).toBe(false);
    }
  });
});

describe('AppConfig v3 migration (spec §7)', () => {
  it('migrates a real v2 config without loss and defaults the toggle off', () => {
    const v2 = {
      version: 2,
      grids: [
        {
          id: 'grid:\\\\.\\DISPLAY1@0,0',
          monitorIds: ['\\\\.\\DISPLAY1@0,0'],
          cols: 12,
          rows: 6,
          mode: 'collision',
          enabled: true,
          activeTemplateId: null,
          gap: 8,
          padding: 16,
        },
      ],
      templates: [
        {
          id: 'tpl:user:mine',
          name: 'Mine',
          cols: 8,
          rows: 6,
          slots: [{ col: 0, row: 0, w: 5, h: 6 }],
          builtin: false,
        },
      ],
      exclusions: ['slack.exe'],
      layouts: {
        'grid:\\\\.\\DISPLAY1@0,0': { version: 1, tiles: [] },
      },
      hotkey: 'Ctrl+Alt+G',
      autostart: true,
      paused: true,
      appRules: [
        { exe: 'code.exe', gridId: null, slot: { col: 6, row: 0, w: 6, h: 6 } },
      ],
      views: [
        {
          id: 'view:1',
          name: 'Work',
          grids: [
            {
              settings: {
                id: 'grid:\\\\.\\DISPLAY1@0,0',
                monitorIds: ['\\\\.\\DISPLAY1@0,0'],
                cols: 12,
                rows: 6,
                mode: 'collision',
                enabled: true,
                activeTemplateId: null,
                gap: 8,
                padding: 16,
              },
              assignments: [
                { exe: 'code.exe', slot: { col: 0, row: 0, w: 6, h: 6 } },
              ],
            },
          ],
        },
      ],
      startupViewId: 'view:1',
    };

    const cfg = sanitizeConfig(v2);
    expect(cfg).not.toBeNull();
    expect(cfg!.version).toBe(5);
    expect(cfg!.autoCheckUpdates).toBe(false);

    // Nothing the v2 config carried is lost. The one field that *changes* is
    // the mode spelling: `collision` is what v0.2.0 wrote for today's `push`,
    // and the v4 migration renames it without changing a thing about how the
    // grid behaves.
    expect(cfg!.grids).toEqual(v2.grids.map((g) => ({ ...g, mode: 'push' })));
    expect(cfg!.templates).toEqual(v2.templates);
    expect(cfg!.exclusions).toEqual(['slack.exe']);
    expect(cfg!.layouts).toEqual(v2.layouts);
    expect(cfg!.hotkey).toBe('Ctrl+Alt+G');
    expect(cfg!.autostart).toBe(true);
    expect(cfg!.paused).toBe(true);
    expect(cfg!.appRules).toEqual(v2.appRules);
    expect(cfg!.views).toEqual(
      v2.views.map((v) => ({
        ...v,
        grids: v.grids.map((g) => ({
          ...g,
          settings: { ...g.settings, mode: 'push' },
        })),
      })),
    );
    expect(cfg!.startupViewId).toBe('view:1');

    // The migrated config round-trips stable, and survives a brain reload.
    // (`exportConfig` re-merges the built-in templates, so compare the rest.)
    expect(parseConfig(serializeConfig(cfg!))).toEqual(cfg);
    const reloaded = makeBrain(cfg!).brain.exportConfig();
    expect({ ...reloaded, templates: [] }).toEqual({ ...cfg!, templates: [] });
    expect(reloaded.templates.filter((t) => !t.builtin)).toEqual(v2.templates);
  });

  it('reads a v3 config that opted in, and keeps it opted in', () => {
    const cfg = sanitizeConfig({ ...defaultConfig(), version: 3, autoCheckUpdates: true });
    expect(cfg!.version).toBe(5);
    expect(cfg!.autoCheckUpdates).toBe(true);
    expect(makeBrain(cfg!).brain.exportConfig().autoCheckUpdates).toBe(true);
  });

  it('treats a non-boolean toggle as opted out', () => {
    for (const value of ['true', 1, null, undefined, {}]) {
      const cfg = sanitizeConfig({ ...defaultConfig(), autoCheckUpdates: value });
      expect(cfg!.autoCheckUpdates).toBe(false);
    }
  });
});

describe('setShellPrefs carries the update toggle (contract C3)', () => {
  it('persists the toggle and re-emits a snapshot only on a real change', () => {
    const { brain, snapshots } = makeBrain();
    expect(brain.exportConfig().autoCheckUpdates).toBe(false);

    brain.setShellPrefs({ autoCheckUpdates: false }); // already false
    expect(snapshots).toHaveLength(0);

    brain.setShellPrefs({ autoCheckUpdates: true });
    expect(brain.exportConfig().autoCheckUpdates).toBe(true);
    expect(snapshots).toHaveLength(1);

    brain.setShellPrefs({ autoCheckUpdates: true }); // no-op
    expect(snapshots).toHaveLength(1);

    brain.setShellPrefs({ autoCheckUpdates: false });
    expect(brain.exportConfig().autoCheckUpdates).toBe(false);
    expect(snapshots).toHaveLength(2);
  });

  it('leaves the other shell prefs untouched', () => {
    const { brain } = makeBrain();
    brain.setShellPrefs({ autostart: true, hotkey: 'Ctrl+Alt+G' });
    brain.setShellPrefs({ autoCheckUpdates: true });
    expect(brain.exportConfig()).toMatchObject({
      autostart: true,
      hotkey: 'Ctrl+Alt+G',
      autoCheckUpdates: true,
    });
  });
});
