<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { RoomLink } from '../engine/join';
  import { formatClock } from '../format';
  import { keepAwake } from '../wakeLock';
  import Chat from './Chat.svelte';
  import Icon from './Icon.svelte';
  import JoinGate from './JoinGate.svelte';
  import { JoinSession, saveName } from './joinSession.svelte';
  import { layout } from './layout.svelte';

  let { link }: { link: RoomLink } = $props();

  // svelte-ignore state_referenced_locally
  const session = new JoinSession(link);
  const snap = $derived(session.snap);
  const room = $derived(session.room);
  const watch = $derived(snap?.watch ?? null);
  const live = $derived(snap?.status === 'connected' || snap?.status === 'reconnecting');

  let videoEl: HTMLVideoElement | undefined = $state();
  let playerEl: HTMLElement | undefined = $state();
  let needsTap = $state(false);
  let muted = $state(false);
  let volume = $state(1);
  let fullscreen = $state(false);
  let now = $state(performance.now());
  let scrub = $state<number | null>(null);

  /** Host position, extrapolated between the host's updates. */
  const position = $derived.by(() => {
    if (!watch) return 0;
    const t = watch.time + (watch.playing ? ((now - watch.receivedAt) / 1000) * watch.rate : 0);
    return watch.duration ? Math.min(t, watch.duration) : t;
  });

  onMount(() => {
    layout.wide = true;
    session.start();
    const tick = setInterval(() => (now = performance.now()), 250);
    const onFs = () => (fullscreen = !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      clearInterval(tick);
      document.removeEventListener('fullscreenchange', onFs);
      layout.wide = false;
    };
  });
  onDestroy(() => session.close());

  $effect(() => {
    keepAwake(!!watch?.playing && live);
  });

  // A new state from the host ends any local scrubbing preview.
  $effect(() => {
    watch?.receivedAt;
    scrub = null;
  });

  // Attach the incoming stream whenever its tracks change.
  $effect(() => {
    snap?.mediaVersion;
    if (!videoEl || !room) return;
    if (videoEl.srcObject !== room.media) videoEl.srcObject = room.media;
    startPlayback();
  });

  async function startPlayback() {
    if (!videoEl) return;
    try {
      await videoEl.play();
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') return;
      // Browsers block autoplay with sound until the user interacts; start muted.
      videoEl.muted = muted = true;
      needsTap = true;
      await videoEl.play().catch(() => {});
    }
  }

  function unmute() {
    if (!videoEl) return;
    videoEl.muted = muted = false;
    needsTap = false;
    videoEl.play().catch(() => {});
  }

  function toggleMute() {
    if (needsTap) return unmute();
    muted = !muted;
  }

  function togglePlay() {
    if (!watch) return;
    room?.control(watch.playing ? 'pause' : 'play');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (playerEl?.requestFullscreen) playerEl.requestFullscreen().catch(() => {});
    // iPhone Safari only allows fullscreen on the video element itself.
    else (videoEl as any)?.webkitEnterFullscreen?.();
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest('input, textarea')) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'f') toggleFullscreen();
    else if (e.key === 'm') toggleMute();
  }

  function rename(name: string) {
    saveName(name);
    room?.setName(name);
  }
</script>

<svelte:window onkeydown={onKey} onpagehide={() => session.close()} />

<JoinGate {session} hasContent={!!watch}>
  {#if snap}
    <div class="watch-grid">
      <section class="stack">
        <div class="player" class:fullscreen class:show={!watch?.playing || needsTap} bind:this={playerEl}>
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={videoEl} bind:volume bind:muted playsinline autoplay ondblclick={toggleFullscreen}></video>

          {#if !watch?.source}
            <div class="overlay">
              <Icon name="film" size={36} />
              <p>Waiting for the host to start a video…</p>
            </div>
          {:else if needsTap}
            <button class="overlay tap" onclick={unmute}>
              <Icon name="volume" size={32} />
              <span>Click to turn on sound</span>
            </button>
          {/if}

          <div class="controls">
            {#if watch?.source === 'file'}
              <button class="ctl" onclick={togglePlay} disabled={!live} aria-label={watch.playing ? 'Pause for everyone' : 'Play for everyone'}>
                <Icon name={watch.playing ? 'pause' : 'play'} />
              </button>
              <span class="time">{formatClock(scrub ?? position)} / {formatClock(watch.duration)}</span>
              <input
                class="seek"
                type="range"
                min="0"
                max={watch.duration || 0}
                step="0.1"
                value={scrub ?? position}
                disabled={!live || !watch.duration}
                aria-label="Seek for everyone"
                oninput={(e) => (scrub = +e.currentTarget.value)}
                onchange={(e) => room?.control('seek', +e.currentTarget.value)}
              />
            {:else if watch?.source === 'screen'}
              <span class="live-badge">● Live</span>
              <span class="spacer"></span>
            {:else}
              <span class="spacer"></span>
            {/if}
            <button class="ctl" onclick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
              <Icon name={muted ? 'muted' : 'volume'} />
            </button>
            <input class="volume" type="range" min="0" max="1" step="0.05" bind:value={volume} aria-label="Volume" />
            <button class="ctl" onclick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
              <Icon name={fullscreen ? 'shrink' : 'expand'} />
            </button>
          </div>
        </div>

        <div class="row wrap meta">
          <h2 class="title">{watch?.title || 'Watch together'}</h2>
          <span class="spacer"></span>
          {#if watch?.source === 'file'}
            <span class="muted small">Play, pause and seek apply to everyone.</span>
          {/if}
        </div>
      </section>

      <Chat
        messages={snap.chat}
        myName={snap.name}
        disabled={!live}
        onSend={(t) => room?.chat(t)}
        onRename={rename}
      />
    </div>
  {/if}
</JoinGate>

<style>
  .watch-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  @media (min-width: 960px) {
    .watch-grid {
      grid-template-columns: minmax(0, 1fr) 320px;
    }
  }

  .player {
    position: relative;
    background: #000;
    border-radius: var(--radius);
    overflow: hidden;
    aspect-ratio: 16 / 9;
    color: #fff;
  }

  .player.fullscreen {
    border-radius: 0;
    aspect-ratio: auto;
  }

  video {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
    background: #000;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: rgb(255 255 255 / 0.8);
    text-align: center;
    padding: 20px;
    background: transparent;
    border: none;
    border-radius: 0;
    font-size: 1rem;
  }

  .overlay.tap {
    background: rgb(0 0 0 / 0.45);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
  }

  .overlay.tap:hover {
    background: rgb(0 0 0 / 0.55);
  }

  .controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 28px 10px 8px;
    background: linear-gradient(transparent, rgb(0 0 0 / 0.75));
    opacity: 0;
    transition: opacity 0.2s;
  }

  .player:hover .controls,
  .player:focus-within .controls,
  .player.show .controls {
    opacity: 1;
  }

  @media (hover: none) {
    .controls {
      opacity: 1;
    }
  }

  .ctl {
    background: transparent;
    border: none;
    color: #fff;
    padding: 6px;
    border-radius: 8px;
  }

  .ctl:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.15);
  }

  .time {
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .seek {
    flex: 1;
    min-width: 60px;
    accent-color: var(--accent);
  }

  .volume {
    width: 80px;
    accent-color: #fff;
  }

  @media (max-width: 520px) {
    .volume {
      display: none;
    }
  }

  .live-badge {
    font-size: 0.8rem;
    font-weight: 700;
    color: #ff5a52;
    letter-spacing: 0.04em;
    padding-left: 6px;
  }

  .meta {
    gap: 10px;
  }

  .title {
    font-size: 1.1rem;
    overflow-wrap: anywhere;
  }

  .wrap {
    flex-wrap: wrap;
  }
</style>
