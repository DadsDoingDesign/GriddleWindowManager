<script lang="ts" module>
  /** One entry of the menu. `action` runs on activation; the menu closes. */
  export interface MenuItem {
    label: string;
    /** Destructive entries render in the danger palette. */
    danger?: boolean;
    action: () => void;
  }
</script>

<script lang="ts">
  // Lightweight context menu (spec v0.2 §2 UI). Rendered at a viewport
  // position (position: fixed), clamped so it never hangs off screen.
  // Dismissal: Escape, Tab, click/press outside, window blur. Keyboard: the
  // first item takes focus on open; ArrowUp/ArrowDown cycle, Home/End jump,
  // Enter/Space activate (native button behavior). Focus returns to the
  // element that had it before the menu opened.
  import { onMount } from 'svelte';

  interface Props {
    /** Viewport coordinates the menu opens at (e.g. cursor position). */
    x: number;
    y: number;
    /** Accessible name of the menu. */
    label: string;
    items: MenuItem[];
    onclose: () => void;
  }
  const { x, y, label, items, onclose }: Props = $props();

  /** Gap kept between the menu and the viewport edges when clamping. */
  const EDGE_MARGIN = 6;

  let menuEl: HTMLDivElement | null = $state(null);
  // Reading the props once at init is deliberate: the open position is
  // fixed for the menu's lifetime (a new right-click mounts a new menu).
  /* svelte-ignore state_referenced_locally */
  let left = $state(x);
  /* svelte-ignore state_referenced_locally */
  let top = $state(y);

  onMount(() => {
    const prevFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (menuEl) {
      // Clamp into the viewport now that the rendered size is measurable.
      const r = menuEl.getBoundingClientRect();
      left = Math.max(
        EDGE_MARGIN,
        Math.min(x, window.innerWidth - r.width - EDGE_MARGIN),
      );
      top = Math.max(
        EDGE_MARGIN,
        Math.min(y, window.innerHeight - r.height - EDGE_MARGIN),
      );
      focusItem(0);
    }
    return () => prevFocus?.focus();
  });

  function menuButtons(): HTMLButtonElement[] {
    return menuEl ? [...menuEl.querySelectorAll('button')] : [];
  }

  function focusItem(index: number): void {
    const buttons = menuButtons();
    if (buttons.length === 0) return;
    const i = ((index % buttons.length) + buttons.length) % buttons.length;
    buttons[i]?.focus();
  }

  function focusedIndex(): number {
    return menuButtons().findIndex((b) => b === document.activeElement);
  }

  function onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onclose();
        break;
      case 'Tab':
        // Menus are not tab stops — leaving means closing.
        e.preventDefault();
        onclose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        focusItem(focusedIndex() + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(focusedIndex() - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(0);
        break;
      case 'End':
        e.preventDefault();
        focusItem(items.length - 1);
        break;
    }
  }

  function onWindowPointerDown(e: PointerEvent): void {
    if (menuEl && e.target instanceof Node && !menuEl.contains(e.target)) {
      // Capture-phase stop: the press that dismisses the menu must not also
      // pick up a GriddleGrid tile underneath (its drag starts on
      // pointerdown). Click-driven controls still receive their click.
      e.stopPropagation();
      onclose();
    }
  }

  function activate(item: MenuItem): void {
    // Close first so the restored focus target is decided before the action
    // triggers snapshot-driven re-renders.
    onclose();
    item.action();
  }
</script>

<svelte:window
  onpointerdowncapture={onWindowPointerDown}
  onblur={onclose}
  onresize={onclose}
/>

<div
  bind:this={menuEl}
  class="menu"
  role="menu"
  aria-label={label}
  tabindex="-1"
  style:left="{left}px"
  style:top="{top}px"
  onkeydown={onKeydown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each items as item, i (i)}
    <button
      type="button"
      role="menuitem"
      tabindex="-1"
      class:danger={item.danger === true}
      onclick={() => activate(item)}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 1000;
    min-width: 200px;
    max-width: 340px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--card);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  }

  button {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text);
    font: 500 12.5px/1.35 var(--sans);
    padding: 7px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background 0.1s ease, color 0.1s ease;
  }
  button:hover,
  button:focus-visible {
    background: rgba(139, 124, 246, 0.16);
    color: var(--text-strong);
    outline: none;
  }
  button.danger {
    color: #e79090;
  }
  button.danger:hover,
  button.danger:focus-visible {
    background: rgba(245, 101, 101, 0.14);
    color: #f56565;
  }
</style>
