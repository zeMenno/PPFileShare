<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { JoinSession } from './joinSession.svelte';

  let { session, hasContent, children }: { session: JoinSession; hasContent: boolean; children: Snippet } = $props();
  const snap = $derived(session.snap);
</script>

{#if session.askPassword}
  <section class="card stack narrow">
    <h2>This room needs a password</h2>
    <p class="muted small">The person who sent you the link should have given it to you separately.</p>
    <form
      class="stack"
      onsubmit={(e) => {
        e.preventDefault();
        session.connect();
      }}
    >
      <input type="password" bind:value={session.password} placeholder="Password" aria-label="Password" autocomplete="off" />
      {#if session.wrongPassword}<div class="notice danger small">That password didn't work. Try again.</div>{/if}
      {#if session.openError}<div class="notice danger small">{session.openError}</div>{/if}
      <button class="primary" type="submit" disabled={!session.password || session.opening}>
        {session.opening ? 'Unlocking…' : 'Join room'}
      </button>
    </form>
  </section>
{:else if session.openError}
  <section class="card stack center-card">
    <h2>This link doesn't work</h2>
    <p class="muted">{session.openError}</p>
  </section>
{:else if !snap || snap.status === 'connecting' || snap.status === 'waiting' || snap.status === 'linking'}
  <section class="card center-card stack">
    <div class="spinner"></div>
    {#if snap?.status === 'waiting'}
      <h2>Waiting for the host to let you in…</h2>
      <p class="muted small">They'll see a request from {snap.name}.</p>
    {:else if snap?.status === 'linking'}
      <h2>Connecting directly to the host…</h2>
      <p class="muted small">This usually takes a second or two.</p>
    {:else}
      <h2>Finding the room…</h2>
    {/if}
  </section>
{:else if snap.status === 'failed' && !hasContent}
  <section class="card stack center-card">
    <h2>Couldn't connect</h2>
    <p class="muted measure">{snap.message}</p>
    <div><button class="primary" onclick={() => session.room?.retry()}>Try again</button></div>
  </section>
{:else if (snap.status === 'closed' || snap.status === 'denied' || snap.status === 'wrong-key') && !hasContent}
  <section class="card stack center-card">
    <h2>{snap.status === 'denied' ? 'Not allowed in' : snap.status === 'wrong-key' ? "Link doesn't match" : 'Room closed'}</h2>
    <p class="muted measure">{snap.message}</p>
  </section>
{:else}
  {#if snap.status === 'reconnecting'}
    <div class="notice warn row banner">
      <div class="spinner tiny"></div>
      <span>Connection dropped. Reconnecting…</span>
    </div>
  {:else if snap.status === 'failed'}
    <div class="notice danger row wrap banner">
      <span class="grow">{snap.message}</span>
      <button onclick={() => session.room?.retry()}>Reconnect</button>
    </div>
  {:else if snap.status === 'closed' || snap.status === 'denied'}
    <div class="notice danger banner">{snap.message}</div>
  {/if}
  {@render children()}
{/if}

<style>
  .narrow {
    max-width: 420px;
    margin: 0 auto;
  }

  .center-card {
    text-align: center;
    align-items: center;
    padding: 44px 20px;
  }

  .measure {
    max-width: 34em;
  }

  .wrap {
    flex-wrap: wrap;
  }

  .grow {
    flex: 1;
    min-width: 200px;
  }

  .tiny {
    width: 16px;
    height: 16px;
    border-top-color: currentColor;
  }

  .banner {
    margin-bottom: 16px;
  }
</style>
