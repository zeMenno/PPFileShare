<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { HostRoom, HostSnapshot } from '../engine/host';
  import Chat from './Chat.svelte';
  import Icon from './Icon.svelte';

  let { room, snap, incoming = $bindable(null) }: { room: HostRoom; snap: HostSnapshot; incoming?: File | null } = $props();

  type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

  let fileVideo: CapturableVideo | undefined = $state();
  let screenVideo: HTMLVideoElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let source = $state<'file' | 'screen' | null>(null);
  let title = $state('');
  let error = $state('');
  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  let captured: MediaStream | null = null;
  let screenStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let objectUrl = '';
  let fixingDuration = false;
  let syncTimer: ReturnType<typeof setInterval> | undefined;

  const proto = HTMLMediaElement.prototype as CapturableVideo;
  const canStreamFile = typeof proto.captureStream === 'function' || typeof proto.mozCaptureStream === 'function';
  const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const viewers = $derived(snap.peers.filter((p) => p.status === 'connected' || p.status === 'reconnecting').length);

  const live = (t: MediaStreamTrack | undefined) => (t && t.readyState === 'live' ? t : null);

  function pushTracks(stream: MediaStream | null) {
    room.setMedia(live(stream?.getVideoTracks().at(-1)), live(stream?.getAudioTracks().at(-1)));
  }

  /** Capture the file player once; its tracks change by themselves when the file changes. */
  function captureFilePlayer(): MediaStream {
    if (captured) return captured;
    const v = fileVideo!;
    if (v.captureStream) {
      captured = v.captureStream();
    } else {
      // Firefox: capturing mutes the element, so play the captured audio back ourselves.
      captured = v.mozCaptureStream!();
      captured.addEventListener('addtrack', (ev) => {
        if (ev.track.kind !== 'audio') return;
        audioCtx ??= new AudioContext();
        audioCtx.createMediaStreamSource(new MediaStream([ev.track])).connect(audioCtx.destination);
      });
    }
    captured.addEventListener('addtrack', () => source === 'file' && pushTracks(captured));
    captured.addEventListener('removetrack', () => source === 'file' && pushTracks(captured));
    return captured;
  }

  function sync() {
    const v = fileVideo;
    if (source !== 'file' || !v) return;
    room.setWatchState({
      source: 'file',
      title,
      playing: !v.paused && !v.ended,
      time: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      rate: v.playbackRate,
    });
  }

  function playFile(file: File) {
    if (!fileVideo) return;
    error = '';
    if (!file.type.startsWith('video/') && !file.type.startsWith('audio/') && !/\.(mp4|m4v|mkv|webm|mov|ogv|mp3|m4a|ogg|wav|flac)$/i.test(file.name)) {
      error = `${file.name} doesn't look like a video.`;
      return;
    }
    stopScreen();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    title = file.name.replace(/\.[^.]+$/, '');
    source = 'file';
    captureFilePlayer();
    fileVideo.src = objectUrl;
    fileVideo.play().catch(() => {
      /* autoplay refused: the host presses play */
    });
    sync();
  }

  async function shareScreen() {
    error = '';
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') error = `Screen sharing failed: ${(e as Error).message}`;
      return;
    }
    fileVideo?.pause();
    stopScreen();
    screenStream = stream;
    source = 'screen';
    title = stream.getVideoTracks()[0]?.label || 'Shared screen';
    if (screenVideo) screenVideo.srcObject = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (screenStream === stream) stop();
    });
    pushTracks(stream);
    room.setWatchState({ source: 'screen', title, playing: true, time: 0, duration: 0, rate: 1 });
    if (!stream.getAudioTracks().length) flash('No sound is shared. To include audio, share a browser tab and tick "Share tab audio".');
  }

  function stopScreen() {
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = null;
    if (screenVideo) screenVideo.srcObject = null;
  }

  function stop() {
    stopScreen();
    if (fileVideo) {
      fileVideo.pause();
      fileVideo.removeAttribute('src');
      fileVideo.load();
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    source = null;
    title = '';
    room.setMedia(null, null);
    room.setWatchState({ source: null, title: '', playing: false, time: 0, duration: 0, rate: 1 });
  }

  function flash(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 6000);
  }

  // A video dropped anywhere on the page.
  $effect(() => {
    if (incoming && fileVideo) {
      const f = incoming;
      incoming = null;
      playFile(f);
    }
  });

  onMount(() => {
    room.onControl = (action, time, who) => {
      const v = fileVideo;
      if (!v || source !== 'file') return;
      if (action === 'play') v.play().catch(() => flash(`${who} pressed play, but the browser blocked it. Press play here.`));
      else if (action === 'pause') v.pause();
      else if (action === 'seek' && time !== undefined) v.currentTime = Math.max(0, Math.min(time, v.duration || time));
    };
    syncTimer = setInterval(() => fileVideo && !fileVideo.paused && sync(), 2000);
  });

  onDestroy(() => {
    room.onControl = null;
    clearInterval(syncTimer);
    stopScreen();
    audioCtx?.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
</script>

<input
  bind:this={fileInput}
  type="file"
  accept="video/*,audio/*,.mkv"
  hidden
  onchange={(e) => {
    const f = e.currentTarget.files?.[0];
    if (f) playFile(f);
    e.currentTarget.value = '';
  }}
/>

<div class="watch-grid">
  <section class="stack">
    <div class="player">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={fileVideo}
        class:hidden={source !== 'file'}
        controls
        playsinline
        onplay={sync}
        onpause={sync}
        onseeked={sync}
        onratechange={sync}
        onloadedmetadata={(e) => {
          // Some WebM files (e.g. browser recordings) don't store their length; seeking
          // far past the end makes the browser work it out.
          if (e.currentTarget.duration === Infinity) {
            fixingDuration = true;
            e.currentTarget.currentTime = 1e101;
          }
          sync();
          pushTracks(captured);
        }}
        ondurationchange={(e) => {
          if (fixingDuration && Number.isFinite(e.currentTarget.duration)) {
            fixingDuration = false;
            e.currentTarget.currentTime = 0;
          }
          sync();
        }}
        onplaying={() => pushTracks(captured)}
        onended={sync}
        onerror={() => source === 'file' && (error = "This browser can't play that file. MP4 (H.264) or WebM work everywhere.")}
      ></video>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={screenVideo} class:hidden={source !== 'screen'} muted autoplay playsinline></video>

      {#if !source}
        <div class="picker">
          <p class="lead">What are you watching?</p>
          <div class="row wrap center">
            <button class="primary big" onclick={() => fileInput?.click()} disabled={!canStreamFile}>
              <Icon name="film" /> Choose a video file
            </button>
            {#if canShareScreen}
              <button class="big" onclick={shareScreen}><Icon name="screen" /> Share a tab or screen</button>
            {/if}
          </div>
          <p class="hint">
            {#if canStreamFile}
              …or drop a video anywhere on this page. It plays here and streams live to everyone; they don't need the file.
            {:else}
              This browser can't stream a video file. Use Chrome, Edge or Firefox, or share a tab instead.
            {/if}
          </p>
        </div>
      {/if}
    </div>

    {#if error}<div class="notice danger small">{error}</div>{/if}
    {#if toast}<div class="notice accent small">{toast}</div>{/if}

    <div class="row wrap">
      <h2 class="title">{title || 'Watch together'}</h2>
      <span class="spacer"></span>
      {#if source}
        <button class="small-btn" onclick={() => fileInput?.click()} disabled={!canStreamFile}>Change video</button>
        {#if canShareScreen && source !== 'screen'}<button class="small-btn" onclick={shareScreen}>Share screen</button>{/if}
        <button class="small-btn danger" onclick={stop}>Stop</button>
      {/if}
    </div>
    <p class="muted small">
      {viewers === 0 ? 'Nobody is watching yet.' : `${viewers} watching.`}
      {#if source === 'file'}Everyone can play, pause and seek.{/if}
      Keep this tab visible for smooth video; some browsers slow down video in background tabs.
    </p>
  </section>

  <Chat messages={snap.chat} myName="Host" onSend={(t) => room.sendChat(t)} />
</div>

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
  }

  video {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
    background: #000;
  }

  .hidden {
    display: none;
  }

  .picker {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 20px;
    text-align: center;
    color: #fff;
    background: radial-gradient(circle at 50% 40%, #1d2340, #000 75%);
  }

  .lead {
    font-size: 1.2rem;
    font-weight: 650;
  }

  .hint {
    font-size: 0.85rem;
    color: rgb(255 255 255 / 0.7);
    max-width: 32em;
  }

  .center {
    justify-content: center;
  }

  .wrap {
    flex-wrap: wrap;
  }

  .title {
    font-size: 1.1rem;
    overflow-wrap: anywhere;
  }

  .small-btn {
    padding: 5px 10px;
    font-size: 0.85rem;
  }

  @media (max-width: 560px) {
    .picker .big {
      padding: 10px 14px;
      font-size: 0.95rem;
    }
    .hint {
      display: none;
    }
  }
</style>
