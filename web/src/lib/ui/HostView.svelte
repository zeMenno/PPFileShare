<script lang="ts">
  import { HostRoom, type FileInput, type HostSnapshot, type PeerSnapshot } from '../engine/host';
  import { filesFromDrop, filesFromInput } from '../pickFiles';
  import { formatBytes, formatSpeed, plural } from '../format';
  import { keepAwake, wakeLockSupported } from '../wakeLock';
  import type { RoomKind } from '../engine/protocol';
  import Icon from './Icon.svelte';
  import { layout } from './layout.svelte';
  import Progress from './Progress.svelte';
  import QrCode from './QrCode.svelte';
  import WatchHost from './WatchHost.svelte';

  let room = $state.raw<HostRoom | null>(null);
  let snap = $state.raw<HostSnapshot | null>(null);
  let creating = $state<RoomKind | null>(null);
  let error = $state('');
  /** A video dropped on the page while hosting a watch room. */
  let droppedVideo = $state<File | null>(null);

  // Room options (before creating)
  let usePassword = $state(false);
  let password = $state('');
  let requireApproval = $state(true);
  let closeAfterFirst = $state(false);

  let dragging = $state(false);
  let copied = $state(false);
  let showQr = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  let folderInput: HTMLInputElement | undefined = $state();

  const live = $derived(snap && snap.status !== 'closed');
  const pending = $derived(snap?.peers.filter((p) => p.status === 'pending') ?? []);
  const others = $derived(snap?.peers.filter((p) => p.status !== 'pending' && p.status !== 'verifying') ?? []);
  const connectedCount = $derived(others.filter((p) => p.status === 'connected' || p.status === 'reconnecting').length);
  const sortedFiles = $derived([...(snap?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)));

  $effect(() => {
    keepAwake(!!live && connectedCount > 0);
  });

  $effect(() => {
    document.title = pending.length ? `(${pending.length}) Someone wants to join · P2P File Share` : 'P2P File Share';
  });

  $effect(() => {
    layout.wide = snap?.kind === 'watch' && snap.status !== 'closed';
  });

  async function createRoom(kind: RoomKind, initial: FileInput[] = []) {
    if (creating) return;
    if (usePassword && !password) {
      error = 'Enter a password, or turn the password option off.';
      return;
    }
    creating = kind;
    error = '';
    try {
      const r = await HostRoom.create({
        kind,
        password: usePassword ? password : undefined,
        requireApproval,
        closeAfterFirstDownload: kind === 'files' && closeAfterFirst,
      });
      r.on('change', (s) => (snap = s));
      if (initial.length) r.addFiles(initial);
      room = r;
      snap = r.snapshot();
      if (import.meta.env.DEV) (window as any).__ppHost = r;
    } catch (e) {
      error = (e as Error).message || 'Could not open a room.';
    } finally {
      creating = null;
    }
  }

  function addFiles(list: FileInput[]) {
    if (!list.length) return;
    if (room && live && snap?.kind === 'watch') droppedVideo = list[0].file;
    else if (room && live) room.addFiles(list);
    else createRoom('files', list);
  }

  function newRoom() {
    room?.close();
    room = null;
    snap = null;
    copied = false;
    showQr = false;
  }

  async function copyLink() {
    if (!snap) return;
    try {
      await navigator.clipboard.writeText(snap.link);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      (document.getElementById('room-link') as HTMLInputElement | null)?.select();
    }
  }

  async function shareLink() {
    if (!snap) return;
    try {
      await navigator.share({ title: 'Files for you', url: snap.link });
    } catch {
      /* user dismissed */
    }
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragging = true;
  }

  function onDragLeave(e: DragEvent) {
    if (!e.relatedTarget) dragging = false;
  }

  async function onDrop(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragging = false;
    addFiles(await filesFromDrop(e.dataTransfer));
  }

  function onInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    addFiles(filesFromInput(input.files));
    input.value = '';
  }

  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (live && (connectedCount > 0 || (snap?.files.length ?? 0) > 0)) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  function peerStatus(p: PeerSnapshot): { label: string; tone: string } {
    switch (p.status) {
      case 'connecting':
        return { label: 'Connecting…', tone: '' };
      case 'connected':
        return { label: 'Connected', tone: 'ok' };
      case 'reconnecting':
        return { label: 'Reconnecting…', tone: 'warn' };
      case 'failed':
        return { label: 'Could not connect', tone: 'danger' };
      default:
        return { label: p.status, tone: '' };
    }
  }

  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
</script>

<svelte:window
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onbeforeunload={onBeforeUnload}
  onpagehide={() => room?.close('The host left.')}
/>

<input bind:this={fileInput} type="file" multiple hidden onchange={onInput} />
<input bind:this={folderInput} type="file" webkitdirectory hidden onchange={onInput} />

{#if dragging}
  <div class="drop-overlay" aria-hidden="true">
    <div>{snap?.kind === 'watch' ? 'Drop to play for everyone' : 'Drop to share'}</div>
  </div>
{/if}

{#if !snap}
  <section class="stack hero">
    <div class="stack intro">
      <h1>Share files and watch together, straight from your browser.</h1>
      <p class="muted lead">
        Open a room and share the link. Whoever opens it connects directly to this tab: no uploads, no accounts,
        end-to-end encrypted.
      </p>
    </div>

    <div class="card stack">
      <div class="choices">
        <button class="primary big" onclick={() => createRoom('files')} disabled={!!creating}>
          {#if creating === 'files'}<span class="spinner small-spin"></span> Opening room…{:else}Share files{/if}
        </button>
        <button class="big" onclick={() => createRoom('watch')} disabled={!!creating}>
          {#if creating === 'watch'}<span class="spinner small-spin dark"></span> Opening room…{:else}<Icon name="film" /> Watch together{/if}
        </button>
      </div>
      <p class="muted small center">Drop files anywhere on this page to start sharing right away.</p>

      <details class="options">
        <summary>Room options</summary>
        <div class="stack options-body">
          <label class="toggle">
            <input type="checkbox" bind:checked={requireApproval} />
            <span>Ask me before someone joins<br /><span class="muted small">You'll see who's knocking and can allow or deny them.</span></span>
          </label>
          <label class="toggle">
            <input type="checkbox" bind:checked={usePassword} />
            <span>Require a password<br /><span class="muted small">On top of the link. Send it through a different channel.</span></span>
          </label>
          {#if usePassword}
            <input type="password" placeholder="Room password" bind:value={password} autocomplete="new-password" aria-label="Room password" />
          {/if}
          <label class="toggle">
            <input type="checkbox" bind:checked={closeAfterFirst} />
            <span>Close the room after the first download<br /><span class="muted small">File rooms only.</span></span>
          </label>
        </div>
      </details>

      {#if error}<div class="notice danger">{error}</div>{/if}
    </div>

    <ol class="how muted small">
      <li><strong>Open a room.</strong> Your browser makes a random link and key.</li>
      <li><strong>Add files or pick a video.</strong> They stay on your disk; nothing is uploaded.</li>
      <li><strong>Share the link.</strong> Their browser connects straight to yours: they download the files, or watch the video with you in sync.</li>
      <li><strong>Close the tab</strong> and the room is gone.</li>
    </ol>
  </section>
{:else if snap.status === 'closed'}
  <section class="card stack center-card">
    <h2>Room closed</h2>
    <p class="muted">{snap.closedReason}</p>
    <div><button class="primary" onclick={newRoom}>Open a new room</button></div>
  </section>
{:else}
  <section class="stack">
    {#each pending as p (p.id)}
      <div class="card request">
        <div class="request-text">
          <strong>{p.name}</strong> wants to join.
          <span class="muted small">Only allow people you sent the link to.</span>
        </div>
        <div class="row">
          <button onclick={() => room?.deny(p.id)}>Deny</button>
          <button class="primary" onclick={() => room?.approve(p.id)}>Allow</button>
        </div>
      </div>
    {/each}

    {#if snap.kind === 'watch' && room}
      <WatchHost {room} {snap} bind:incoming={droppedVideo} />
    {/if}

    <div class="card stack">
      <div class="row wrap">
        <h2>{snap.kind === 'watch' ? 'Invite people' : 'Share this link'}</h2>
        <span class="spacer"></span>
        {#if snap.status === 'open'}
          <span class="pill ok">Room open</span>
        {:else if snap.status === 'reconnecting'}
          <span class="pill warn">Reconnecting to server…</span>
        {:else}
          <span class="pill">Opening…</span>
        {/if}
      </div>
      <div class="link-row">
        <input id="room-link" type="text" readonly value={snap.link} onfocus={(e) => e.currentTarget.select()} aria-label="Room link" />
        <button class="primary" onclick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
        {#if canShare}<button onclick={shareLink}>Share</button>{/if}
        <button onclick={() => (showQr = !showQr)} aria-expanded={showQr}>QR</button>
      </div>
      {#if showQr}
        <div class="qr-wrap"><QrCode value={snap.link} /></div>
      {/if}
      <p class="muted small">
        Anyone with the full link can {snap.options.requireApproval ? 'ask to join' : snap.kind === 'watch' ? 'watch' : 'download'}. Share it like a password.
        {#if snap.hasPassword}This room also needs the password you set; send that separately.{/if}
      </p>
    </div>

    {#if snap.kind === 'files'}
    <div class="card stack files-card" class:empty={!snap.files.length}>
      <div class="row wrap">
        <h2>Files</h2>
        {#if snap.files.length}
          <span class="muted small">{plural(snap.files.length, 'file')} · {formatBytes(snap.totalSize)}</span>
        {/if}
        <span class="spacer"></span>
        <div class="row">
          <button onclick={() => fileInput?.click()}>Add files</button>
          <button onclick={() => folderInput?.click()}>Add folder</button>
        </div>
      </div>

      {#if !snap.files.length}
        <button class="dropzone" onclick={() => fileInput?.click()}>
          <span>Drop files or folders here</span>
          <span class="muted small">or click to choose</span>
        </button>
      {:else}
        <ul class="file-list">
          {#each sortedFiles as f (f.id)}
            {@const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}
            <li>
              <div class="file-name">
                <span class="name" title={f.path}>{#if dir}<span class="dir">{dir}</span>{/if}{f.name}</span>
              </div>
              <span class="file-size">{formatBytes(f.size)}</span>
              <button class="icon ghost" title="Stop sharing {f.name}" aria-label="Stop sharing {f.name}" onclick={() => room?.removeFile(f.id)}>✕</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {/if}

    <div class="card stack">
      <div class="row">
        <h2>People</h2>
        <span class="spacer"></span>
        {#if snap.transferring}<span class="pill ok">Sending</span>{/if}
      </div>
      {#if !others.length}
        <p class="muted small">Nobody here yet. When someone opens the link, they'll show up here.</p>
      {:else}
        <ul class="peers">
          {#each others as p (p.id)}
            {@const st = peerStatus(p)}
            <li class="stack">
              <div class="row wrap">
                <strong>{p.name}</strong>
                <span class="pill {st.tone}">{st.label}</span>
                <span class="spacer"></span>
                {#if p.sending && p.speed > 0}<span class="muted small">{formatSpeed(p.speed)}</span>{/if}
                <button class="small-btn" onclick={() => room?.disconnect(p.id)}>Disconnect</button>
              </div>
              {#if p.error}<p class="muted small">{p.error}</p>{/if}
              {#each p.transfers as t (t.fileId)}
                <div class="transfer">
                  <div class="row small">
                    <span class="ellipsis">{t.name}</span>
                    <span class="spacer"></span>
                    <span class="muted">{t.complete ? 'Downloaded' : `${Math.floor((t.sent / Math.max(1, t.size)) * 100)}%`}</span>
                  </div>
                  <Progress value={t.complete ? 1 : t.sent / Math.max(1, t.size)} tone={t.complete ? 'ok' : 'accent'} />
                </div>
              {/each}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="card stack">
      <h2>Settings</h2>
      <label class="toggle">
        <input
          type="checkbox"
          checked={snap.options.requireApproval}
          onchange={(e) => room?.setOption('requireApproval', e.currentTarget.checked)}
        />
        <span>Ask me before someone joins</span>
      </label>
      {#if snap.kind === 'files'}
        <label class="toggle">
          <input
            type="checkbox"
            checked={snap.options.closeAfterFirstDownload}
            onchange={(e) => room?.setOption('closeAfterFirstDownload', e.currentTarget.checked)}
          />
          <span>Close the room after the first download</span>
        </label>
      {/if}
    </div>

    <div class="notice small">
      {#if snap.kind === 'watch'}
        Keep this tab open: the video streams straight from this browser to everyone watching.
      {:else}
        Keep this tab open while people download: files go straight from this browser to theirs.
      {/if}
      {#if connectedCount > 0 && wakeLockSupported}The screen stays on while someone is connected.{/if}
    </div>

    <div class="row">
      <span class="spacer"></span>
      <button class="danger" onclick={() => room?.close()}>Close room</button>
    </div>
  </section>
{/if}

<style>
  .hero {
    gap: 28px;
  }

  .choices {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  @media (max-width: 480px) {
    .choices {
      grid-template-columns: 1fr;
    }
  }

  .small-spin.dark {
    border-color: var(--border);
    border-top-color: var(--accent);
  }

  .intro {
    gap: 12px;
    padding-top: 12px;
  }

  .lead {
    font-size: 1.08rem;
    max-width: 38em;
  }

  .center {
    text-align: center;
  }

  .center-card {
    text-align: center;
    align-items: center;
    padding: 40px 20px;
  }

  .options summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.92rem;
  }

  .options-body {
    padding-top: 14px;
    gap: 14px;
  }

  .how {
    margin: 0;
    padding-left: 1.3em;
    display: grid;
    gap: 6px;
  }

  .how strong {
    color: var(--text);
    font-weight: 600;
  }

  .small-spin {
    width: 16px;
    height: 16px;
    border-color: rgb(255 255 255 / 0.35);
    border-top-color: currentColor;
  }

  .request {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .request-text {
    flex: 1;
    min-width: 200px;
    display: flex;
    flex-direction: column;
  }

  .wrap {
    flex-wrap: wrap;
  }

  .link-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .link-row input {
    flex: 1 1 260px;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }

  .qr-wrap {
    display: flex;
    justify-content: center;
  }

  .dropzone {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 36px 16px;
    border: 1.5px dashed var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    width: 100%;
    font-weight: 560;
  }

  .peers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .peers li {
    gap: 10px;
  }

  .transfer {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .small-btn {
    padding: 5px 10px;
    font-size: 0.85rem;
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    backdrop-filter: blur(2px);
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  .drop-overlay div {
    background: var(--surface);
    border: 2px dashed var(--accent);
    border-radius: var(--radius);
    padding: 28px 40px;
    font-size: 1.2rem;
    font-weight: 650;
  }
</style>
