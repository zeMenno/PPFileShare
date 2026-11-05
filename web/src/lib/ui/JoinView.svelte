<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { JoinRoom, type JoinSnapshot, type RoomLink } from '../engine/join';
  import { chooseSink, hasFileSystemAccess, memorySink, willBufferInMemory } from '../engine/sinks';
  import type { FileMeta } from '../engine/protocol';
  import { formatBytes, formatEta, formatSpeed, plural } from '../format';
  import { keepAwake } from '../wakeLock';
  import Progress from './Progress.svelte';

  let { link }: { link: RoomLink } = $props();

  let room = $state.raw<JoinRoom | null>(null);
  let snap = $state.raw<JoinSnapshot | null>(null);
  let openError = $state('');
  let opening = $state(false);
  let password = $state('');
  let askPassword = $state(false);
  let wrongPassword = $state(false);
  let memoryWarning = $state(false);
  const selected = new SvelteSet<number>();
  const seen = new Set<number>();

  const files = $derived([...(snap?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)));
  const busy = (id: number) => {
    const s = snap?.downloads[id]?.status;
    return s === 'active' || s === 'queued';
  };
  const selectable = $derived(files.filter((f) => !busy(f.id)));
  const chosen = $derived(selectable.filter((f) => selected.has(f.id)));
  const chosenSize = $derived(chosen.reduce((n, f) => n + f.size, 0));
  const allSelected = $derived(selectable.length > 0 && selectable.every((f) => selected.has(f.id)));
  const totalSize = $derived(files.reduce((n, f) => n + f.size, 0));
  const live = $derived(snap?.status === 'connected' || snap?.status === 'reconnecting');

  $effect(() => {
    keepAwake(!!snap?.downloading);
  });

  // New files show up selected.
  $effect(() => {
    for (const f of snap?.files ?? []) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        selected.add(f.id);
      }
    }
  });

  $effect(() => {
    const list = chosen;
    willBufferInMemory(list).then((v) => (memoryWarning = v));
  });

  async function connect() {
    if (opening) return;
    opening = true;
    openError = '';
    wrongPassword = false;
    try {
      const r = await JoinRoom.open(link, link.needsPassword ? password : undefined);
      r.on('change', (s) => {
        snap = s;
        if (s.status === 'wrong-key' && link.needsPassword) {
          wrongPassword = true;
          askPassword = true;
          r.close();
          room = null;
        }
      });
      room = r;
      snap = r.snapshot();
      askPassword = false;
      if (import.meta.env.DEV) (window as any).__ppJoin = Object.assign(r, { memorySink });
    } catch (e) {
      openError = (e as Error).message || 'Could not open this link.';
    } finally {
      opening = false;
    }
  }

  onMount(() => {
    if (link.needsPassword) askPassword = true;
    else connect();
  });

  onDestroy(() => room?.close());

  function toggleAll() {
    if (allSelected) selectable.forEach((f) => selected.delete(f.id));
    else selectable.forEach((f) => selected.add(f.id));
  }

  async function download(list: FileMeta[]) {
    if (!room || !list.length) return;
    // chooseSink may open a save/folder picker, so it must run straight from the click.
    const factory = await chooseSink(list);
    if (!factory) return;
    room.download(
      list.map((f) => f.id),
      factory,
    );
    list.forEach((f) => selected.delete(f.id));
  }

  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (snap?.downloading) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  function statusText(id: number): string {
    const d = snap?.downloads[id];
    if (!d) return '';
    switch (d.status) {
      case 'queued':
        return 'Waiting…';
      case 'active':
        return `${Math.floor((d.received / Math.max(1, d.size)) * 100)}%`;
      case 'done':
        return 'Saved';
      case 'cancelled':
        return 'Cancelled';
      case 'error':
        return 'Failed';
    }
  }
</script>

<svelte:window onbeforeunload={onBeforeUnload} />

{#if askPassword}
  <section class="card stack narrow">
    <h2>This room needs a password</h2>
    <p class="muted small">The person who sent you the link should have given it to you separately.</p>
    <form
      class="stack"
      onsubmit={(e) => {
        e.preventDefault();
        connect();
      }}
    >
      <input type="password" bind:value={password} placeholder="Password" aria-label="Password" autocomplete="off" />
      {#if wrongPassword}<div class="notice danger small">That password didn't work. Try again.</div>{/if}
      {#if openError}<div class="notice danger small">{openError}</div>{/if}
      <button class="primary" type="submit" disabled={!password || opening}>{opening ? 'Unlocking…' : 'Join room'}</button>
    </form>
  </section>
{:else if openError}
  <section class="card stack center-card">
    <h2>This link doesn't work</h2>
    <p class="muted">{openError}</p>
  </section>
{:else if !snap || snap.status === 'connecting' || snap.status === 'waiting' || snap.status === 'linking'}
  <section class="card center-card stack">
    <div class="spinner"></div>
    {#if snap?.status === 'waiting'}
      <h2>Waiting for the host to let you in…</h2>
      <p class="muted small">They'll see a request from this device.</p>
    {:else if snap?.status === 'linking'}
      <h2>Connecting directly to the host…</h2>
      <p class="muted small">This usually takes a second or two.</p>
    {:else}
      <h2>Finding the room…</h2>
    {/if}
  </section>
{:else if snap.status === 'failed' && !snap.files.length}
  <section class="card stack center-card">
    <h2>Couldn't connect</h2>
    <p class="muted measure">{snap.message}</p>
    <div><button class="primary" onclick={() => room?.retry()}>Try again</button></div>
  </section>
{:else if (snap.status === 'closed' || snap.status === 'denied' || snap.status === 'wrong-key') && !snap.files.length}
  <section class="card stack center-card">
    <h2>{snap.status === 'denied' ? 'Not allowed in' : snap.status === 'wrong-key' ? "Link doesn't match" : 'Room closed'}</h2>
    <p class="muted measure">{snap.message}</p>
  </section>
{:else}
  <section class="stack">
    {#if snap.status === 'reconnecting'}
      <div class="notice warn row">
        <div class="spinner tiny"></div>
        <span>Connection dropped. Reconnecting… Downloads continue where they left off.</span>
      </div>
    {:else if snap.status === 'failed'}
      <div class="notice danger row wrap">
        <span class="grow">{snap.message}</span>
        <button onclick={() => room?.retry()}>Reconnect</button>
      </div>
    {:else if snap.status === 'closed' || snap.status === 'denied'}
      <div class="notice danger">{snap.message}</div>
    {/if}

    <div class="card stack">
      <div class="row wrap">
        <div class="stack tight">
          <h2>Files shared with you</h2>
          <span class="muted small">{plural(files.length, 'file')} · {formatBytes(totalSize)}</span>
        </div>
        <span class="spacer"></span>
        {#if snap.downloading}
          <span class="muted small">{formatSpeed(snap.speed)} {formatEta(snap.remaining, snap.speed) && `· ${formatEta(snap.remaining, snap.speed)}`}</span>
        {/if}
      </div>

      {#if !files.length}
        <p class="muted small">The host hasn't added any files yet. They'll appear here as soon as they do.</p>
      {:else}
        <div class="row select-row">
          <label class="toggle">
            <input type="checkbox" checked={allSelected} onchange={toggleAll} disabled={!selectable.length} />
            <span class="small">Select all</span>
          </label>
          <span class="spacer"></span>
          <button class="primary" disabled={!chosen.length || !live} onclick={() => download(chosen)}>
            {chosen.length ? `Download ${plural(chosen.length, 'file')} (${formatBytes(chosenSize)})` : 'Download'}
          </button>
        </div>

        {#if memoryWarning}
          <div class="notice warn small">
            This browser can't stream big files to disk here, so large files are held in memory until they finish.
            Very large files may not work; Chrome or Edge on a computer handles them best.
          </div>
        {:else if hasFileSystemAccess && chosen.length > 1}
          <p class="muted small">You'll pick a folder to save into; sub-folders are kept.</p>
        {/if}

        <ul class="file-list">
          {#each files as f (f.id)}
            {@const d = snap.downloads[f.id]}
            {@const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}
            <li>
              <input
                type="checkbox"
                aria-label="Select {f.name}"
                checked={selected.has(f.id)}
                disabled={busy(f.id)}
                onchange={(e) => (e.currentTarget.checked ? selected.add(f.id) : selected.delete(f.id))}
              />
              <div class="file-name">
                <span class="name" title={f.path}>{#if dir}<span class="dir">{dir}</span>{/if}{f.name}</span>
                {#if d && d.status !== 'cancelled'}
                  <Progress
                    value={d.status === 'done' ? 1 : d.received / Math.max(1, d.size)}
                    tone={d.status === 'done' ? 'ok' : d.status === 'error' ? 'danger' : 'accent'}
                  />
                  {#if d.error}<span class="error small">{d.error}</span>{/if}
                {/if}
              </div>
              <span class="file-size">
                {#if d}<span class="state {d.status}">{statusText(f.id)}</span> · {/if}{formatBytes(f.size)}
              </span>
              {#if busy(f.id)}
                <button class="icon ghost" title="Cancel" aria-label="Cancel {f.name}" onclick={() => room?.cancel(f.id)}>✕</button>
              {:else}
                <button class="icon ghost" title="Download {f.name}" aria-label="Download {f.name}" disabled={!live} onclick={() => download([f])}>↓</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if snap.downloading}
      <div class="notice small">Keep this tab open until your downloads finish.</div>
    {/if}
  </section>
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

  .tight {
    gap: 2px;
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

  .select-row {
    padding-bottom: 2px;
  }

  .state.done {
    color: var(--ok);
    font-weight: 600;
  }

  .state.error {
    color: var(--danger);
    font-weight: 600;
  }

  .error {
    color: var(--danger);
  }
</style>
