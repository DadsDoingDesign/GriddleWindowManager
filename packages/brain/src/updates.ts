// Update-check state machine (spec §7 "Update checks", opt-in updater).
//
// Pure like the rest of `packages/brain`: no Tauri, no DOM, no timers, no
// clock of its own. The brain host owns the plugin calls and feeds the
// outcome in as events; this module owns *when a check is allowed to happen
// at all* and what the UI is allowed to say about it.
//
// The whole point of putting the policy here is that the one guarantee that
// matters — **the toggle being off means nothing touches the network** — is a
// pure function anyone can read and a test can pin down, rather than a
// condition buried in an async driver. The host has exactly two entry points
// into the network: `shouldAutoCheck` (the timer path) and `canCheckNow`
// (the explicit "Check now" button); neither can be reached by accident.

/** Phase of the update flow the UI renders from. */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** Version offered by the feed; null unless one is on the table. */
  version: string | null;
  /** Release notes for that version ('' when the feed carries none). */
  notes: string;
  /** Publication date string from the feed, or null. */
  date: string | null;
  /** Bytes fetched so far (`downloading` only). */
  downloaded: number;
  /** Content length, or null when the server sent none. */
  total: number | null;
  /**
   * The download finished and the installer has been handed the package.
   * Still `phase: 'downloading'` — the flow is one user-visible operation
   * ("getting the update") and this only swaps the label to "Installing…".
   */
  installing: boolean;
  /** Epoch ms of the last *completed* check, success or failure. */
  lastCheckedAt: number | null;
  /** The last completed check found nothing newer. */
  upToDate: boolean;
  /** Message of the last failure, '' otherwise. */
  error: string;
}

export type UpdateEvent =
  | { type: 'check-started' }
  | {
      type: 'check-found';
      version: string;
      notes?: string;
      date?: string | null;
      at: number;
    }
  | { type: 'check-none'; at: number }
  | { type: 'check-failed'; message: string; at: number }
  | { type: 'download-started' }
  // The content length arrives in the transfer's own first event, after the
  // download is already under way — hence its own event rather than a field
  // on `download-started`, which the driver has to send first so a failure
  // before the first byte still has a phase to fail out of.
  | { type: 'download-total'; total: number }
  | { type: 'download-progress'; chunk: number }
  | { type: 'install-started' }
  | { type: 'download-failed'; message: string }
  | { type: 'dismiss' };

/** Auto-check cadence when the user opted in: once per day. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function initialUpdateState(): UpdateState {
  return {
    phase: 'idle',
    version: null,
    notes: '',
    date: null,
    downloaded: 0,
    total: null,
    installing: false,
    lastCheckedAt: null,
    upToDate: false,
    error: '',
  };
}

function nonNegative(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Fold one event into the state. Events that do not apply to the current
 * phase are ignored (the state is returned unchanged, by identity) — the
 * driver is async, so a late `download-progress` from an abandoned attempt or
 * a second `check-started` must never rewind a newer phase.
 */
export function updateReducer(state: UpdateState, ev: UpdateEvent): UpdateState {
  switch (ev.type) {
    case 'check-started':
      // Never interrupt a download in flight, and never start a second check.
      if (state.phase === 'checking' || state.phase === 'downloading') return state;
      return {
        ...state,
        phase: 'checking',
        error: '',
        // The previous verdict is stale the moment a new check begins.
        upToDate: false,
      };

    case 'check-found':
      if (state.phase !== 'checking') return state;
      return {
        ...state,
        phase: 'available',
        version: ev.version,
        notes: ev.notes ?? '',
        date: ev.date ?? null,
        downloaded: 0,
        total: null,
        installing: false,
        lastCheckedAt: ev.at,
        upToDate: false,
        error: '',
      };

    case 'check-none':
      if (state.phase !== 'checking') return state;
      return {
        ...state,
        phase: 'idle',
        version: null,
        notes: '',
        date: null,
        lastCheckedAt: ev.at,
        upToDate: true,
        error: '',
      };

    case 'check-failed':
      if (state.phase !== 'checking') return state;
      return {
        ...state,
        phase: 'error',
        lastCheckedAt: ev.at,
        upToDate: false,
        error: ev.message,
      };

    case 'download-started':
      // Only ever from an offer the user just confirmed.
      if (state.phase !== 'available') return state;
      return {
        ...state,
        phase: 'downloading',
        downloaded: 0,
        total: null,
        installing: false,
        error: '',
      };

    case 'download-total': {
      if (state.phase !== 'downloading') return state;
      const total = nonNegative(ev.total);
      return { ...state, total: total > 0 ? total : null };
    }

    case 'download-progress':
      if (state.phase !== 'downloading') return state;
      return { ...state, downloaded: state.downloaded + nonNegative(ev.chunk) };

    case 'install-started':
      if (state.phase !== 'downloading') return state;
      return { ...state, installing: true };

    case 'download-failed':
      if (state.phase !== 'downloading') return state;
      // Keep `version`: the offer is still real, the user can retry it.
      return { ...state, phase: 'error', installing: false, error: ev.message };

    case 'dismiss':
      // "Not now" on the banner, and the way out of an error. A download in
      // flight is not dismissable — it is already changing the machine.
      if (state.phase !== 'available' && state.phase !== 'error') return state;
      return {
        ...state,
        phase: 'idle',
        version: null,
        notes: '',
        date: null,
        downloaded: 0,
        total: null,
        installing: false,
        error: '',
      };

    default:
      return state;
  }
}

/**
 * **The privacy guarantee.** The host's periodic driver asks this before it
 * is allowed to touch the network, and it answers `false` for every state
 * whenever `enabled` is false — that is what "default off means no network
 * call" reduces to. With the user opted in it is true once at launch
 * (nothing checked yet) and then once per `intervalMs`.
 *
 * It also answers `false` while a check or download is already running, and
 * while an offer is on the table: re-asking GitHub what we already know
 * would be a pointless request.
 */
export function shouldAutoCheck(
  state: UpdateState,
  opts: { enabled: boolean; now: number; intervalMs?: number },
): boolean {
  if (!opts.enabled) return false;
  if (state.phase !== 'idle' && state.phase !== 'error') return false;
  if (state.lastCheckedAt === null) return true;
  const interval = opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  return opts.now - state.lastCheckedAt >= interval;
}

/**
 * May the user's explicit "Check now" run? Deliberately independent of the
 * toggle — clicking the button *is* the consent — and blocked only by a
 * check or download that is already in flight.
 */
export function canCheckNow(state: UpdateState): boolean {
  return state.phase !== 'checking' && state.phase !== 'downloading';
}

/** Is there an offer the user can confirm? Nothing installs without one. */
export function canInstall(state: UpdateState): boolean {
  return state.phase === 'available' && state.version !== null;
}

/**
 * Download progress in 0..1, or null when the server sent no content length
 * (the UI then shows an indeterminate bar rather than inventing a number).
 */
export function downloadFraction(state: UpdateState): number | null {
  if (state.total === null || state.total <= 0) return null;
  return Math.min(state.downloaded / state.total, 1);
}
