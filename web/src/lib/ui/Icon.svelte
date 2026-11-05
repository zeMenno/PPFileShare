<script lang="ts">
  type Name = 'play' | 'pause' | 'volume' | 'muted' | 'expand' | 'shrink' | 'film' | 'screen';
  let { name, size = 20 }: { name: Name; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === 'play'}
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  {:else if name === 'pause'}
    <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
  {:else if name === 'volume'}
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none" />
    <path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
  {:else if name === 'muted'}
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none" />
    <path d="M16 9.5l5 5M21 9.5l-5 5" />
  {:else if name === 'expand'}
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  {:else if name === 'shrink'}
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  {:else if name === 'film'}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  {:else if name === 'screen'}
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  {/if}
</svg>
