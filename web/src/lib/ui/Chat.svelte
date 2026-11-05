<script lang="ts">
  import type { ChatMessage } from '../engine/protocol';

  let {
    messages,
    myName,
    onSend,
    onRename,
    disabled = false,
  }: {
    messages: ChatMessage[];
    myName: string;
    onSend: (text: string) => void;
    onRename?: (name: string) => void;
    disabled?: boolean;
  } = $props();

  let text = $state('');
  let list: HTMLElement | undefined = $state();
  let editing = $state(false);
  let draft = $state('');

  // Stick to the bottom as messages arrive.
  $effect(() => {
    messages.length;
    requestAnimationFrame(() => list && (list.scrollTop = list.scrollHeight));
  });

  function send(e: SubmitEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    text = '';
  }

  function saveName(e: SubmitEvent) {
    e.preventDefault();
    const n = draft.trim();
    if (n) onRename?.(n);
    editing = false;
  }

  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<div class="card chat">
  <div class="head">
    <h2>Chat</h2>
    <span class="spacer"></span>
    {#if editing}
      <form class="row name-form" onsubmit={saveName}>
        <input type="text" bind:value={draft} maxlength="40" aria-label="Your name" placeholder="Your name" />
        <button type="submit" class="small-btn">Save</button>
      </form>
    {:else if onRename}
      <button
        class="ghost small-btn"
        title="Change your name"
        onclick={() => {
          draft = myName;
          editing = true;
        }}>You: {myName} ✎</button
      >
    {:else}
      <span class="muted small">You: {myName}</span>
    {/if}
  </div>

  <ul class="msgs" bind:this={list} aria-live="polite">
    {#each messages as m (m.id)}
      <li class:system={m.system}>
        {#if m.system}
          <span><strong>{m.from}</strong> {m.text}</span>
        {:else}
          <span><strong>{m.from}</strong>&nbsp; {m.text}</span>
        {/if}
        <time>{time(m.at)}</time>
      </li>
    {:else}
      <li class="empty">No messages yet. Say hi 👋</li>
    {/each}
  </ul>

  <form class="row compose" onsubmit={send}>
    <input type="text" bind:value={text} placeholder="Message" maxlength="500" aria-label="Message" {disabled} />
    <button class="primary" type="submit" disabled={disabled || !text.trim()}>Send</button>
  </form>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    min-height: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
  }

  .name-form input {
    width: 140px;
    padding: 5px 8px;
  }

  .small-btn {
    padding: 5px 10px;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--muted);
  }

  .msgs {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    min-height: 160px;
    max-height: 420px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.93rem;
    overflow-wrap: anywhere;
  }

  .msgs li {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }

  .msgs li span {
    flex: 1;
    min-width: 0;
  }

  .msgs li.system {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .msgs li.system strong {
    font-weight: 600;
  }

  time {
    color: var(--muted);
    font-size: 0.75rem;
    flex: none;
  }

  .empty {
    color: var(--muted);
    font-size: 0.88rem;
  }

  .compose input {
    flex: 1;
  }
</style>
