// Updater driver (spec §7 "Update checks") — the brain host's side of the
// opt-in update flow.
//
// Why here and not in the settings window: the brain host is the only
// always-running page, it owns the config (so it knows whether the user
// opted in) and the persistence + pause machinery the installer handoff
// needs. The settings window renders `update-state` and sends three intents
// (check now / install / not now); it holds no updater handle at all, and the
// `updater` capability is granted to the `main` window only.
//
// Every decision about *whether* to touch the network is delegated to the
// pure `shouldAutoCheck` / `canCheckNow` / `canInstall` policy in
// `@griddle-wm/brain`, which is where the "off means no network" guarantee is
// tested. This file only carries the plugin calls, the timer, and the
// handoff ordering.

import {
  canCheckNow,
  canInstall,
  initialUpdateState,
  shouldAutoCheck,
  updateReducer,
  type UpdateEvent,
  type UpdateState,
} from '@griddle-wm/brain';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { emitUpdateState, setUpdateHandoff, setUpdateStatus } from '../../lib/ipc';

/**
 * How often the driver re-evaluates whether an automatic check is due. The
 * *cadence* is `UPDATE_CHECK_INTERVAL_MS` (24 h) and lives in the policy;
 * this is only how finely the wall clock is sampled, so a machine that was
 * asleep across the 24 h mark checks shortly after waking rather than a day
 * later. It costs one pure function call — no network, ever, unless the
 * policy says yes.
 */
const AUTO_CHECK_POLL_MS = 15 * 60 * 1000;

/** Human-readable one-liner for anything the plugin throws at us. */
function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const s = String(e);
  return s === '[object Object]' ? 'the update check failed' : s;
}

export interface UpdaterDriver {
  /** Current state (what the settings window renders). */
  readonly state: UpdateState;
  /** Re-broadcast the current state — used when a settings window opens. */
  broadcast(): void;
  /** The user pressed "Check now". Allowed regardless of the toggle. */
  checkNow(): Promise<void>;
  /**
   * Re-evaluate the automatic cadence. Called on a timer and whenever the
   * user flips the toggle, so opting in checks immediately instead of at the
   * next poll.
   */
  maybeAutoCheck(): void;
  /** The user confirmed the offer: download, then hand off to the installer. */
  installNow(): Promise<void>;
  /** "Not now", and the way out of an error. */
  dismiss(): void;
  destroy(): void;
}

export function startUpdater(opts: {
  /** Live read of `config.autoCheckUpdates` (the brain owns the value). */
  autoCheckEnabled: () => boolean;
  /** Flush the debounced config save — run before the installer handoff. */
  persistNow: () => Promise<void>;
  now?: () => number;
}): UpdaterDriver {
  const now = opts.now ?? Date.now;
  let state = initialUpdateState();
  /** The plugin handle behind an offer; a Resource, so it gets closed. */
  let pending: Update | null = null;
  let destroyed = false;

  const dispatch = (ev: UpdateEvent) => {
    const next = updateReducer(state, ev);
    if (next === state) return; // out-of-phase event; nothing to tell anyone
    const hadOffer = state.phase === 'available';
    state = next;
    emitUpdateState(state).catch((e) => console.error('update-state emit failed:', e));
    // Keep the tray entry in step with the offer, in both directions: it
    // appears when one arrives and goes away the moment it stops being one
    // (dismissed, superseded by a fresh check, downloading, failed).
    const hasOffer = state.phase === 'available';
    if (hasOffer !== hadOffer) {
      setUpdateStatus(hasOffer, hasOffer ? state.version : null).catch((e) =>
        console.error('set_update_status failed:', e),
      );
    }
  };

  const releasePending = () => {
    const update = pending;
    pending = null;
    // Best-effort: a leaked resource handle is harmless, a throw here is not.
    if (update !== null) void update.close().catch(() => {});
  };

  const runCheck = async () => {
    dispatch({ type: 'check-started' });
    try {
      const update = await check();
      if (destroyed) {
        if (update !== null) await update.close().catch(() => {});
        return;
      }
      if (update === null) {
        releasePending();
        dispatch({ type: 'check-none', at: now() });
        return;
      }
      releasePending();
      pending = update;
      dispatch({
        type: 'check-found',
        version: update.version,
        notes: update.body ?? '',
        date: update.date ?? null,
        at: now(),
      });
    } catch (e) {
      console.error('update check failed:', e);
      dispatch({ type: 'check-failed', message: messageOf(e), at: now() });
    }
  };

  const driver: UpdaterDriver = {
    get state() {
      return state;
    },

    broadcast() {
      emitUpdateState(state).catch((e) =>
        console.error('update-state re-emit failed:', e),
      );
    },

    async checkNow() {
      // The click is the consent — deliberately not gated on the toggle.
      if (destroyed || !canCheckNow(state)) return;
      await runCheck();
    },

    maybeAutoCheck() {
      if (destroyed) return;
      if (!shouldAutoCheck(state, { enabled: opts.autoCheckEnabled(), now: now() })) {
        return;
      }
      void runCheck();
    },

    async installNow() {
      const update = pending;
      // Nothing installs without a live offer the user just confirmed — a
      // forged `settings-install-update` finds no handle and no phase.
      if (destroyed || update === null || !canInstall(state)) return;

      dispatch({ type: 'download-started' });
      try {
        await update.download((ev) => {
          if (ev.event === 'Started') {
            if (typeof ev.data.contentLength === 'number') {
              dispatch({ type: 'download-total', total: ev.data.contentLength });
            }
          } else if (ev.event === 'Progress') {
            dispatch({ type: 'download-progress', chunk: ev.data.chunkLength });
          }
        });
      } catch (e) {
        console.error('update download failed:', e);
        dispatch({ type: 'download-failed', message: messageOf(e) });
        return;
      }

      // Point of no return. Order matters and is the whole reason this lives
      // in the brain host: the config reaches disk while it is still true
      // (unpaused, current layouts), and only then does the shell freeze.
      try {
        await opts.persistNow();
      } catch (e) {
        console.error('pre-install config flush failed:', e);
        dispatch({
          type: 'download-failed',
          message: `could not save your settings before installing: ${messageOf(e)}`,
        });
        return;
      }
      await setUpdateHandoff(true).catch((e) =>
        console.error('set_update_handoff(true) failed:', e),
      );
      dispatch({ type: 'install-started' });
      try {
        await update.install();
        // Unreachable on Windows: the NSIS installer runs with /R and the
        // plugin exits the process itself, so the restart is the installer's
        // doing. Kept as the honest fallback for a platform where `install`
        // returns — and as the thing that makes the promise "relaunch" true.
        await relaunch();
      } catch (e) {
        console.error('update install failed:', e);
        // Give the user their window manager back rather than a frozen one.
        await setUpdateHandoff(false).catch((err) =>
          console.error('set_update_handoff(false) failed:', err),
        );
        dispatch({ type: 'download-failed', message: messageOf(e) });
      }
    },

    dismiss() {
      if (destroyed) return;
      if (state.phase === 'available') releasePending();
      dispatch({ type: 'dismiss' });
    },

    destroy() {
      destroyed = true;
      clearInterval(pollTimer);
      releasePending();
    },
  };

  const pollTimer = setInterval(() => driver.maybeAutoCheck(), AUTO_CHECK_POLL_MS);
  // Launch check (only if the user opted in — `maybeAutoCheck` asks the
  // policy, which answers `false` for every state while the toggle is off).
  driver.maybeAutoCheck();

  return driver;
}
