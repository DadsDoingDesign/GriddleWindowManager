<script lang="ts">
  /**
   * A number you can step *or* type (spec 2026-08-20).
   *
   * The steppers alone made large jumps tedious — going 12 → 3 columns is
   * nine clicks — so every numeric value in Settings is now a real input.
   * It stays an `<input>` at all times rather than swapping between a label
   * and an editor: mode-switching on click loses the first keystroke and
   * makes the hit target lie about what it is.
   *
   * Commit rules, chosen so a half-typed value can never reach the grid:
   * - Enter or blur commits, clamped into [min, max].
   * - Escape reverts and blurs.
   * - Anything unparseable reverts on commit.
   * - While focused, external updates (the +/- buttons, a config reload) do
   *   not overwrite what you are typing.
   */
  interface Props {
    value: number;
    min: number;
    max: number;
    /** Accessible name, e.g. "Columns". */
    label: string;
    disabled?: boolean;
    /** Rendered after the number when not editing, e.g. "px". */
    suffix?: string;
    onCommit: (next: number) => void;
  }

  let {
    value,
    min,
    max,
    label,
    disabled = false,
    suffix = '',
    onCommit,
  }: Props = $props();

  let el: HTMLInputElement | null = $state(null);
  let focused = $state(false);
  /**
   * Non-null only while editing. Keeping the draft separate from the prop —
   * rather than syncing them in an effect — means an external update (the
   * +/- buttons, a config reload) is picked up automatically whenever the
   * field is not focused, with no stale-copy window to reason about.
   */
  let draft: string | null = $state(null);
  const shown = $derived(draft ?? String(value));

  function commit(): void {
    if (draft === null) return;
    const parsed = Number.parseInt(draft.trim(), 10);
    if (!Number.isFinite(parsed)) {
      draft = null; // unparseable: fall back to the authoritative value
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    draft = null;
    if (clamped !== value) onCommit(clamped);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      el?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      draft = null;
      el?.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Arrow keys are the keyboard twin of the +/- buttons.
      e.preventDefault();
      const step = e.key === 'ArrowUp' ? 1 : -1;
      const next = Math.min(max, Math.max(min, value + step));
      if (next !== value) onCommit(next);
    }
  }
</script>

<span class="numfield" class:disabled>
  <input
    bind:this={el}
    type="text"
    inputmode="numeric"
    aria-label={label}
    {disabled}
    value={shown}
    oninput={(e) => (draft = e.currentTarget.value)}
    onfocus={(e) => {
      focused = true;
      draft = String(value);
      e.currentTarget.select();
    }}
    onblur={() => {
      focused = false;
      commit();
    }}
    onkeydown={onKeydown}
  />
  {#if suffix && !focused}<span class="suffix">{suffix}</span>{/if}
</span>

<style>
  .numfield {
    display: inline-flex;
    align-items: baseline;
    gap: 1px;
  }

  input {
    /* Sized to the widest value any of these fields holds (3 digits), so the
       row does not reflow as the number changes. */
    width: 3.2ch;
    padding: 2px 4px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-strong);
    font: inherit;
    font-variant-numeric: tabular-nums;
    text-align: center;
    cursor: text;
  }

  /* Readable as editable before it is clicked, without shouting. */
  input:hover:not(:disabled) {
    border-color: var(--border);
    background: var(--well);
  }

  input:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--well);
    /* Widen while editing so a typed 3-digit value is fully visible. */
    width: 4ch;
  }

  input:disabled {
    cursor: default;
    color: var(--text-dim);
  }

  .suffix {
    font-size: 12px;
    color: var(--text-dim);
  }
</style>
