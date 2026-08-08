<script lang="ts">
  // Per-monitor transparent drag overlay. Task 15 renders grid lines, the
  // preview footprint, and ghost outlines for the grid in ?gridId=.
  const gridId = new URLSearchParams(window.location.search).get('gridId')
</script>

<main>
  <p>Overlay for grid: {gridId ?? '(none)'}</p>
</main>
