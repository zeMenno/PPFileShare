<script lang="ts">
  import { parseRoomLink } from './lib/engine/join';
  import HostView from './lib/ui/HostView.svelte';
  import JoinView from './lib/ui/JoinView.svelte';
  import { layout } from './lib/ui/layout.svelte';
  import WatchView from './lib/ui/WatchView.svelte';

  const link = parseRoomLink();
</script>

<div class="shell" class:wide={layout.wide}>
  <header>
    <a class="brand" href="/" aria-label="P2P File Share home">
      <img src="/favicon.svg" alt="" width="26" height="26" />
      <span>P2P File Share</span>
    </a>
  </header>

  <main>
    {#if link?.kind === 'watch'}
      <WatchView {link} />
    {:else if link}
      <JoinView {link} />
    {:else}
      <HostView />
    {/if}
  </main>

  <footer class="muted small">
    Everything travels straight between browsers, end-to-end encrypted. Nothing is uploaded or stored.
  </footer>
</div>

<style>
  .shell {
    max-width: 760px;
    margin: 0 auto;
    padding: 20px 16px 40px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .shell.wide {
    max-width: 1240px;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-weight: 680;
    color: var(--text);
    text-decoration: none;
    letter-spacing: -0.01em;
  }

  main {
    flex: 1;
  }

  footer {
    text-align: center;
  }
</style>
