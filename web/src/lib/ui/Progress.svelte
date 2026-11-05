<script lang="ts">
  let { value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' | 'danger' } = $props();
  const pct = $derived(Math.max(0, Math.min(100, value * 100)));
</script>

<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pct)}>
  <div class="fill {tone}" style:width="{pct}%"></div>
</div>

<style>
  .bar {
    height: 5px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.2s linear;
  }

  .fill.ok {
    background: var(--ok);
  }

  .fill.danger {
    background: var(--danger);
  }
</style>
