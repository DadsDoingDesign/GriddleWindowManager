<script lang="ts">
  // Hidden coordinator webview (plan Task 12). Hosts the WindowManagerBrain
  // that drives real windows; the page body is only visible when the window
  // is shown for debugging.
  import { onDestroy, onMount } from 'svelte';
  import { startBrainHost, type BrainHost } from './host';

  let host: BrainHost | null = $state(null);
  let error: string | null = $state(null);
  let tick = $state(0); // bump to refresh the debug view

  onMount(async () => {
    try {
      host = await startBrainHost();
      // Devtools hook for the plan's manual smoke test, e.g.:
      //   await __griddle.enableGridOnMonitor()          // primary, 12×6
      //   __griddle.brain / __griddle.lastSnapshot
      (window as unknown as Record<string, unknown>).__griddle = host;
    } catch (e) {
      error = String(e);
      console.error('brain host failed to start:', e);
    }
  });

  onDestroy(() => host?.destroy());

  const interval = setInterval(() => (tick = tick + 1), 1000);
  onDestroy(() => clearInterval(interval));

  const snapshot = $derived.by(() => {
    void tick;
    return host?.lastSnapshot ?? null;
  });
</script>

<main>
  <h1>Griddle Window Manager brain</h1>
  <p>
    This window is normally hidden. It hosts the layout brain that drives real
    windows. If you can read this, the window was shown for debugging.
  </p>
  {#if error}
    <p class="error">Brain failed to start: {error}</p>
  {:else if !host}
    <p>Starting…</p>
  {:else if snapshot}
    <h2>Last snapshot</h2>
    <ul>
      {#each snapshot.grids as g (g.id)}
        <li>
          <code>{g.id}</code> — {g.cols}×{g.rows} {g.mode}
          {g.enabled ? '' : '(disabled)'} · {(snapshot.tiles[g.id] ?? []).length}
          tile(s)
        </li>
      {/each}
    </ul>
    <p>{snapshot.floating.length} floating window(s) · paused: {snapshot.paused}</p>
  {:else}
    <p>Brain running; no snapshot emitted yet.</p>
  {/if}
</main>

<style>
  .error {
    color: #c0392b;
  }
</style>
