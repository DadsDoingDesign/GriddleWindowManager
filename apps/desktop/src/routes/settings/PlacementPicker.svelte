<script lang="ts">
  // An in-page replacement for the native <select> used by the Placement
  // control (field report 2026-08-20).
  //
  // A native <select> opens an OS popup, and in the undecorated settings
  // pop-out that popup was landing far from its control — out in the middle
  // of the screen — as though the window were at the origin. wry already
  // forwards WM_MOVE to `NotifyParentWindowPositionChanged`, so the usual
  // hook is in place and chasing it further would have been guesswork against
  // WebView2 internals.
  //
  // Rendering the list ourselves sidesteps the OS popup entirely, and is the
  // better answer anyway: an unstyled system list looked foreign against this
  // panel, and it could never show the per-option blurbs at the width the
  // pop-out actually has.
  //
  // Keyboard and ARIA follow the listbox pattern, so this is not a downgrade
  // from the element it replaces: the trigger owns focus and `aria-activedescendant`
  // points at the highlighted option, which keeps a screen reader on the
  // button while the arrows move through the list.

  interface Option {
    value: string;
    label: string;
    blurb: string;
  }

  const {
    value,
    options,
    onchange,
    disabled = false,
    label = 'Placement',
    compact = false,
  }: {
    value: string;
    options: Option[];
    onchange: (v: string) => void;
    disabled?: boolean;
    label?: string;
    /**
     * Sit inside a band that already names the control (Figma 110-344): drop
     * the built-in label and the inline blurb, and let the trigger fill its
     * cell rather than drawing a second box inside one.
     */
    compact?: boolean;
  } = $props();

  let open = $state(false);
  /** Index the keyboard is on while open; -1 until the list is entered. */
  let active = $state(-1);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();

  const selected = $derived(options.find((o) => o.value === value) ?? options[0]);
  const selectedIndex = $derived(Math.max(0, options.findIndex((o) => o.value === value)));
  const listId = `placement-list-${Math.random().toString(36).slice(2, 8)}`;

  function show(): void {
    if (disabled) return;
    active = selectedIndex;
    open = true;
  }

  function hide(): void {
    open = false;
    active = -1;
  }

  function choose(v: string): void {
    if (v !== value) onchange(v);
    hide();
    trigger?.focus();
  }

  function onTriggerKey(e: KeyboardEvent): void {
    if (disabled) return;
    if (!open) {
      // Down/Up/Enter/Space all open, matching the native control.
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % options.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + options.length) % options.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      active = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      active = options.length - 1;
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[active];
      if (o) choose(o.value);
    } else if (e.key === 'Tab') {
      // Leaving the control commits nothing, same as closing the native list.
      hide();
    }
  }

  /**
   * Close when focus or the pointer leaves. `pointerdown` rather than `click`
   * so the list is gone before the click lands on whatever is underneath —
   * otherwise a click meant for the control behind it opened the list again.
   */
  function onDocPointerDown(e: PointerEvent): void {
    if (!open || !root) return;
    if (!root.contains(e.target as Node)) hide();
  }
</script>

<svelte:document onpointerdown={onDocPointerDown} />

<div class="picker" bind:this={root} class:disabled class:compact>
  <span class="lbl" id="{listId}-label" class:sr-only={compact}>{label}</span>
  <button
    type="button"
    class="trigger"
    bind:this={trigger}
    {disabled}
    role="combobox"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-labelledby="{listId}-label"
    aria-controls={open ? listId : undefined}
    aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
    title={selected ? `${selected.label} — ${selected.blurb}` : label}
    onclick={() => (open ? hide() : show())}
    onkeydown={onTriggerKey}
  >
    <span class="value">
      {#if selected}
        <span class="name">{selected.label}</span>
        {#if !compact}<span class="blurb">— {selected.blurb}</span>{/if}
      {/if}
    </span>
    <span class="caret" aria-hidden="true">&#x2304;</span>
  </button>

  {#if open}
    <ul class="list" id={listId} role="listbox" aria-labelledby="{listId}-label" tabindex="-1">
      {#each options as o, i (o.value)}
        <!-- The listbox uses the `aria-activedescendant` pattern: focus stays
             on the combobox, which owns every key, so an option needs no
             keyboard handler of its own and must not be focusable. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="{listId}-opt-{i}"
          role="option"
          class="opt"
          class:active={i === active}
          aria-selected={o.value === value}
          onpointerenter={() => (active = i)}
          onclick={() => choose(o.value)}
        >
          <span class="name">{o.label}</span>
          <span class="blurb">{o.blurb}</span>
          {#if o.value === value}<span class="tick" aria-hidden="true">&#x2713;</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .lbl {
    font-size: 12.5px;
    color: var(--faint);
    white-space: nowrap;
  }

  /* Kept for screen readers: the band's own label is visual only. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* In a band the cell *is* the control: no second border, full height. */
  .picker.compact {
    height: 100%;
    gap: 0;
  }
  .picker.compact .trigger {
    max-width: none;
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0 10px 0 12px;
    justify-content: space-between;
  }
  .picker.compact .trigger:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .picker.compact .list {
    top: calc(100% + 1px);
    right: 0;
  }

  .trigger {
    margin-left: auto;
    max-width: 68%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--muted);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
  }
  .trigger:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .trigger:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
  }
  .trigger:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .value {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value .name {
    font-weight: 600;
    color: var(--text);
  }
  .value .blurb {
    color: var(--faint);
  }

  .caret {
    flex: 0 0 auto;
    color: var(--faint);
    line-height: 1;
  }

  /*
   * Anchored to the control rather than to the viewport, so it travels with
   * the row when the panel scrolls. Right-aligned because the trigger is.
   */
  .list {
    position: absolute;
    z-index: 40;
    top: calc(100% + 4px);
    right: 0;
    min-width: 100%;
    margin: 0;
    padding: 4px;
    list-style: none;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--surface);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5);
  }

  .opt {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 8px;
    padding: 7px 9px;
    border-radius: 7px;
    cursor: pointer;
  }
  .opt .name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
  }
  .opt .blurb {
    grid-column: 1 / -1;
    font-size: 11.5px;
    color: var(--faint);
  }
  .opt.active {
    background: rgba(139, 124, 246, 0.16);
  }
  .opt[aria-selected='true'] .name {
    color: var(--accent);
  }
  /* Beside the name, not under the blurb: the blurb spans both columns, so
     without explicit placement the tick is pushed onto a third row. */
  .tick {
    grid-row: 1;
    grid-column: 2;
    align-self: center;
    color: var(--accent);
    font-size: 12px;
  }
</style>
