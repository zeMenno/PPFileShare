<script lang="ts">
  import { parseRoomLink } from './lib/engine/join';
  import HostView from './lib/ui/HostView.svelte';
  import JoinView from './lib/ui/JoinView.svelte';

  const link = parseRoomLink();
</script>

<div class="shell">
  <header>
    <a class="brand" href="/" aria-label="P2P File Share home">
      <img src="/favicon.svg" alt="" width="26" height="26" />
      <span>P2P File Share</span>
    </a>
  </header>

  <main>
    {#if link}
      <JoinView {link} />
    {:else}
      <HostView />
    {/if}
  </main>

  <footer class="muted small">
    Files travel straight between browsers, end-to-end encrypted. Nothing is uploaded or stored.
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
