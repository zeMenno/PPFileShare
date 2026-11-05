// Joiner side: connects to the host, receives the file list and pulls files by
// requesting byte ranges. Because the receiver drives, a dropped connection just
// means "reconnect and ask again from where we were".

import { config } from './config';
import { deriveRoomKey, fromB64u, openJson, randomId, sealJson, toB64u } from './crypto';
import { CryptoWorker } from './cryptoWorker';
import { Observable } from './emitter';
import {
  AAD_HOST,
  AAD_PEER,
  aadSignal,
  cleanName,
  MAX_CHAT_LENGTH,
  type ChatMessage,
  type FileMeta,
  type HostMsg,
  type PeerMsg,
  type PlaybackAction,
  type RoomKind,
  type SignalMsg,
  type WatchState,
} from './protocol';
import { createSignaling, type ServerMsg, type Signaling } from './signaling';
import { SpeedMeter } from './speed';
import type { Sink, SinkFactory } from './sinks';

export type JoinStatus =
  | 'connecting' // reaching the signaling server / the room
  | 'waiting' // waiting for the host to let us in
  | 'linking' // approved, setting up the direct connection
  | 'connected'
  | 'reconnecting'
  | 'denied'
  | 'wrong-key'
  | 'closed'
  | 'failed';

export type DownloadStatus = 'queued' | 'active' | 'done' | 'error' | 'cancelled';

export interface DownloadSnapshot {
  fileId: number;
  status: DownloadStatus;
  received: number;
  size: number;
  error?: string;
}

export interface JoinSnapshot {
  status: JoinStatus;
  message?: string;
  files: FileMeta[];
  downloads: Record<number, DownloadSnapshot>;
  speed: number;
  downloading: boolean;
  /** Bytes still to come across all queued and active downloads. */
  remaining: number;
  /** Host's playback state; receivedAt (performance.now()) lets the UI extrapolate the position. */
  watch: (WatchState & { receivedAt: number }) | null;
  chat: ChatMessage[];
  /** Bumped whenever the incoming media tracks change. */
  mediaVersion: number;
  name: string;
}

interface Download {
  meta: FileMeta;
  status: DownloadStatus;
  factory: SinkFactory;
  sink: Sink | null;
  /** Bytes written to disk, contiguous from 0. */
  written: number;
  /** Bytes requested so far (everything below this has been asked for). */
  requested: number;
  /** Decrypted chunks that arrived out of order, by offset. */
  pending: Map<number, ArrayBuffer>;
  writing: boolean;
  lastProgress: number;
  error?: string;
}

export interface RoomLink {
  roomId: string;
  linkKey: string;
  needsPassword: boolean;
  kind: RoomKind;
}

export const NETWORK_MESSAGE =
  "Couldn't make a direct connection to the host. One of the two networks probably blocks " +
  'peer-to-peer traffic (common on office Wi-Fi and some mobile carriers). Try another network, ' +
  'or have the host try from a different one.';

/** Read room id and key from a /r/<id>#k=... URL. */
export function parseRoomLink(loc: { pathname: string; hash: string } = location): RoomLink | null {
  const m = loc.pathname.match(/^\/r\/([A-Za-z0-9_-]{10,64})\/?$/);
  if (!m) return null;
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''));
  return {
    roomId: m[1],
    linkKey: params.get('k') || '',
    needsPassword: params.get('p') === '1',
    kind: params.get('m') === 'w' ? 'watch' : 'files',
  };
}

/**
 * Ask the sender for stereo, high-bitrate Opus. WebRTC defaults to mono voice
 * settings, which sound flat for films and music.
 */
function preferHifiOpus(sdp: string): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_line, params: string) => {
    const kept = params
      .split(';')
      .filter((p) => p && !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(p.trim()));
    return `a=fmtp:${pt} ${[...kept, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=256000', 'usedtx=0'].join(';')}`;
  });
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

function stableClientId(): string {
  try {
    let id = sessionStorage.getItem('pp-client-id');
    if (!id) sessionStorage.setItem('pp-client-id', (id = randomId()));
    return id;
  } catch {
    return randomId();
  }
}

const MAX_RECONNECTS = 8;
const STALL_MS = 12_000;

export class JoinRoom extends Observable<JoinSnapshot> {
  readonly roomId: string;
  readonly key: CryptoKey;
  readonly worker = new CryptoWorker();

  #status: JoinStatus = 'connecting';
  #message?: string;
  #files: FileMeta[] = [];
  #chunkSize = 0;
  #downloads = new Map<number, Download>();
  #batchDone = false;
  #speed = new SpeedMeter();
  #clientId = stableClientId();

  #sig: Signaling | null = null;
  #pc: RTCPeerConnection | null = null;
  #ctrl: RTCDataChannel | null = null;
  #queuedIce: RTCIceCandidateInit[] = [];
  #ctrlChain: Promise<unknown> = Promise.resolve();
  #everConnected = false;
  #reconnects = 0;
  #connectTimer?: ReturnType<typeof setTimeout>;
  #lostTimer?: ReturnType<typeof setTimeout>;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #stallTimer: ReturnType<typeof setInterval>;

  // Watch-together
  /** Incoming video/audio from the host. Stable object; its tracks change on reconnect. */
  readonly media = new MediaStream();
  #mediaVersion = 0;
  #watch: (WatchState & { receivedAt: number }) | null = null;
  #chat: ChatMessage[] = [];
  #name: string;

  static async open(link: RoomLink, password?: string, name?: string): Promise<JoinRoom> {
    if (!link.linkKey) throw new Error('This link is missing its key. Ask for the full link, including the part after #.');
    const key = await deriveRoomKey(link.linkKey, password);
    const room = new JoinRoom(link.roomId, key, name);
    await room.worker.init(key);
    room.#connect();
    return room;
  }

  private constructor(roomId: string, key: CryptoKey, name?: string) {
    super();
    this.roomId = roomId;
    this.key = key;
    this.#name = cleanName(name, deviceName());
    this.#stallTimer = setInterval(() => this.#checkStalls(), 3000);
  }

  // ---------------------------------------------------------------- watch together

  control(action: PlaybackAction, time?: number) {
    this.#sendCtrl({ t: 'control', action, time });
  }

  chat(text: string) {
    const clean = text.trim().slice(0, MAX_CHAT_LENGTH);
    if (clean) this.#sendCtrl({ t: 'chat', text: clean });
  }

  setName(name: string) {
    this.#name = cleanName(name, deviceName());
    this.#sendCtrl({ t: 'name', name: this.#name });
    this.changed();
  }

  #clearMedia() {
    for (const t of this.media.getTracks()) this.media.removeTrack(t);
    this.#mediaVersion++;
  }

  snapshot(): JoinSnapshot {
    const downloads: Record<number, DownloadSnapshot> = {};
    let remaining = 0;
    for (const d of this.#downloads.values()) {
      downloads[d.meta.id] = { fileId: d.meta.id, status: d.status, received: d.written, size: d.meta.size, error: d.error };
      if (d.status === 'queued' || d.status === 'active') remaining += d.meta.size - d.written;
    }
    return {
      status: this.#status,
      message: this.#message,
      files: this.#files,
      downloads,
      speed: this.#speed.rate(),
      downloading: [...this.#downloads.values()].some((d) => d.status === 'active' || d.status === 'queued'),
      remaining,
      watch: this.#watch,
      chat: this.#chat,
      mediaVersion: this.#mediaVersion,
      name: this.#name,
    };
  }

  get isFinal() {
    return ['denied', 'wrong-key', 'closed'].includes(this.#status);
  }

  // ---------------------------------------------------------------- connection

  #setStatus(status: JoinStatus, message?: string) {
    this.#status = status;
    this.#message = message;
    this.emit('change', this.snapshot());
  }

  async #connect() {
    this.#teardown();
    this.#setStatus(this.#everConnected ? 'reconnecting' : 'connecting');
    const sig = createSignaling();
    sig.on('message', (m) => this.#onServer(sig, m));
    sig.on('close', () => this.#onSignalingClose(sig));
    this.#sig = sig;
    try {
      await sig.connect();
    } catch (e) {
      if (this.#sig === sig) this.#retryOrFail((e as Error).message);
      return;
    }
    if (this.#sig !== sig) return sig.close();
    sig.send({ type: 'join', room: this.roomId });
  }

  /** Retry after a failure the user can't fix (e.g. a dropped network). */
  retry() {
    if (this.#status !== 'failed') return;
    this.#reconnects = 0;
    this.#connect();
  }

  #retryOrFail(message: string) {
    if (this.isFinal) return;
    this.#teardown();
    if (this.#everConnected && this.#reconnects < MAX_RECONNECTS) {
      const delay = Math.min(1000 * 2 ** this.#reconnects, 8000);
      this.#reconnects++;
      this.#setStatus('reconnecting', 'Lost the connection to the host. Reconnecting…');
      this.#retryTimer = setTimeout(() => this.#connect(), delay);
    } else {
      this.#setStatus('failed', message);
    }
  }

  #final(status: JoinStatus, message: string) {
    this.#teardown();
    if (status === 'closed' || status === 'denied') {
      for (const d of this.#downloads.values()) {
        if (d.status === 'active' || d.status === 'queued') this.#failDownload(d, 'The host closed the room before this finished.');
      }
    }
    this.#setStatus(status, message);
  }

  #teardown() {
    clearTimeout(this.#connectTimer);
    clearTimeout(this.#lostTimer);
    clearTimeout(this.#retryTimer);
    this.#sig?.close();
    this.#sig = null;
    if (this.#ctrl) this.#ctrl.onclose = null;
    this.#ctrl = null;
    if (this.#pc) this.#clearMedia();
    this.#pc?.close();
    this.#pc = null;
    this.#queuedIce = [];
    this.#ctrlChain = Promise.resolve();
  }

  #sendSignal(msg: SignalMsg) {
    const sig = this.#sig;
    if (!sig) return;
    sealJson(this.key, msg, aadSignal(this.roomId)).then((box) => sig.send({ type: 'signal', data: { box: toB64u(box) } }));
  }

  #onServer(sig: Signaling, m: ServerMsg) {
    if (sig !== this.#sig) return;
    switch (m.type) {
      case 'joined':
        this.#sendSignal({ t: 'hello', clientId: this.#clientId, name: this.#name });
        if (!this.#everConnected) this.#setStatus('waiting');
        return;
      case 'error':
        if (m.code === 'no-room') {
          if (this.#everConnected) this.#retryOrFail('The host closed the room.');
          else this.#final('closed', "This room doesn't exist (anymore). The host may have closed the tab.");
        } else if (m.code === 'room-full') {
          this.#final('failed', 'This room is full.');
        } else {
          this.#retryOrFail(`The signaling server refused the connection (${m.code}).`);
        }
        return;
      case 'kicked':
        if (m.reason === 'bad-key') this.#final('wrong-key', 'The key in this link (or the password) does not match this room.');
        else if (m.reason === 'denied') this.#final('denied', 'The host did not let you in.');
        else this.#retryOrFail('The host did not respond.');
        return;
      case 'room-closed':
        // Host's signaling dropped. An existing direct connection keeps working.
        if (this.#status === 'connected') {
          this.#sig?.close();
          this.#sig = null;
        } else if (this.#everConnected) {
          this.#retryOrFail('The host closed the room.');
        } else {
          this.#final('closed', 'The host closed the room.');
        }
        return;
      case 'signal':
        this.#onSignal(m.data?.box);
        return;
    }
  }

  #onSignalingClose(sig: Signaling) {
    if (sig !== this.#sig) return;
    this.#sig = null;
    if (this.#status === 'connected') return; // fine, we only lose ICE restarts
    this.#retryOrFail('Lost the connection to the signaling server.');
  }

  async #onSignal(box: unknown) {
    if (typeof box !== 'string') return;
    let msg: SignalMsg;
    try {
      msg = await openJson<SignalMsg>(this.key, fromB64u(box), aadSignal(this.roomId));
    } catch {
      return; // not from someone holding the key
    }
    switch (msg.t) {
      case 'welcome':
        if (this.#status !== 'reconnecting') this.#setStatus('linking');
        clearTimeout(this.#connectTimer);
        this.#connectTimer = setTimeout(() => {
          if (this.#ctrl?.readyState !== 'open') this.#retryOrFail(NETWORK_MESSAGE);
        }, config.connectTimeoutMs);
        return;
      case 'offer':
        await this.#onOffer(msg.sdp);
        return;
      case 'ice':
        if (!this.#pc) return;
        if (!this.#pc.remoteDescription) this.#queuedIce.push(msg.candidate);
        else await this.#pc.addIceCandidate(msg.candidate).catch(() => {});
        return;
    }
  }

  async #onOffer(sdp: RTCSessionDescriptionInit) {
    const pc = this.#pc ?? this.#createPc();
    try {
      await pc.setRemoteDescription(sdp);
      for (const c of this.#queuedIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription({ type: 'answer', sdp: preferHifiOpus(answer.sdp ?? '') });
      const d = pc.localDescription!;
      this.#sendSignal({ t: 'answer', sdp: { type: d.type, sdp: d.sdp } });
    } catch (e) {
      console.warn('could not answer offer', e);
    }
  }

  #createPc(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    this.#pc = pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.#sendSignal({ t: 'ice', candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      if (this.#pc !== pc) return;
      for (const t of this.media.getTracks()) if (t.kind === ev.track.kind) this.media.removeTrack(t);
      this.media.addTrack(ev.track);
      this.#mediaVersion++;
      this.changed();
    };
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'ctrl') {
        this.#ctrl = ch;
        ch.onopen = () => this.#onCtrlOpen();
        ch.onmessage = (e) => this.#onCtrlMessage(e.data);
        ch.onclose = () => {
          if (this.#pc === pc) this.#retryOrFail('Lost the connection to the host.');
        };
        if (ch.readyState === 'open') this.#onCtrlOpen();
      } else {
        ch.onmessage = (e) => this.#onFrame(e.data);
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.#pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(this.#lostTimer);
        if (this.#status === 'reconnecting' && this.#ctrl?.readyState === 'open') this.#setStatus('connected');
      } else if (s === 'disconnected') {
        // Give the host a moment to do an ICE restart before starting over.
        if (this.#status === 'connected') this.#setStatus('reconnecting', 'Connection hiccup. Reconnecting…');
        clearTimeout(this.#lostTimer);
        this.#lostTimer = setTimeout(() => {
          if (this.#pc === pc && pc.connectionState !== 'connected') this.#retryOrFail('Lost the connection to the host.');
        }, config.connectTimeoutMs);
      } else if (s === 'failed') {
        this.#retryOrFail(this.#everConnected ? 'Lost the connection to the host.' : NETWORK_MESSAGE);
      }
    };
    return pc;
  }

  #onCtrlOpen() {
    clearTimeout(this.#connectTimer);
    this.#everConnected = true;
    this.#reconnects = 0;
    this.#setStatus('connected');
  }

  // ---------------------------------------------------------------- control channel

  #sendCtrl(msg: PeerMsg) {
    const ctrl = this.#ctrl;
    this.#ctrlChain = this.#ctrlChain.then(async () => {
      const sealed = await sealJson(this.key, msg, AAD_PEER);
      if (ctrl?.readyState === 'open') ctrl.send(sealed);
    });
  }

  async #onCtrlMessage(data: unknown) {
    if (!(data instanceof ArrayBuffer)) return;
    let msg: HostMsg;
    try {
      msg = await openJson<HostMsg>(this.key, new Uint8Array(data), AAD_HOST);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'manifest':
        this.#files = Array.isArray(msg.files) ? msg.files : [];
        this.#chunkSize = msg.chunkSize;
        this.#resumeAfterManifest();
        this.changed();
        return;
      case 'error': {
        const d = msg.file !== undefined ? this.#downloads.get(msg.file) : undefined;
        if (d) this.#failDownload(d, msg.message);
        return;
      }
      case 'watch':
        this.#watch = { ...msg.state, receivedAt: performance.now() };
        this.changed();
        return;
      case 'chat': {
        const fresh = (Array.isArray(msg.messages) ? msg.messages : []).filter((m) => !this.#chat.some((c) => c.id === m.id));
        if (fresh.length) {
          this.#chat = [...this.#chat, ...fresh].slice(-300);
          this.changed();
        }
        return;
      }
      case 'bye':
        this.#final('closed', 'The host closed the room.');
        return;
    }
  }

  // ---------------------------------------------------------------- downloads

  /** Queue files for download. The factory decides where each file is written. */
  download(fileIds: number[], factory: SinkFactory) {
    this.#batchDone = false;
    for (const id of fileIds) {
      const meta = this.#files.find((f) => f.id === id);
      if (!meta) continue;
      const existing = this.#downloads.get(id);
      if (existing && (existing.status === 'active' || existing.status === 'queued')) continue;
      this.#downloads.set(id, {
        meta,
        status: 'queued',
        factory,
        sink: null,
        written: 0,
        requested: 0,
        pending: new Map(),
        writing: false,
        lastProgress: performance.now(),
      });
    }
    this.#startNext();
    this.changed();
  }

  cancel(fileId: number) {
    const d = this.#downloads.get(fileId);
    if (!d || (d.status !== 'active' && d.status !== 'queued')) return;
    const wasActive = d.status === 'active';
    d.status = 'cancelled';
    d.pending.clear();
    d.sink?.abort('cancelled').catch(() => {});
    if (wasActive) this.#sendCtrl({ t: 'cancel', file: fileId });
    this.#afterDownloadEnded();
  }

  cancelAll() {
    for (const d of [...this.#downloads.values()]) this.cancel(d.meta.id);
  }

  #startNext() {
    if (this.#status !== 'connected' && this.#status !== 'reconnecting') return;
    let active = [...this.#downloads.values()].filter((d) => d.status === 'active').length;
    for (const d of this.#downloads.values()) {
      if (active >= config.parallelFiles) break;
      if (d.status !== 'queued') continue;
      active++;
      this.#begin(d);
    }
  }

  async #begin(d: Download) {
    d.status = 'active';
    d.lastProgress = performance.now();
    try {
      d.sink = await d.factory(d.meta);
    } catch (e) {
      this.#failDownload(d, (e as Error).message || 'Could not open the file for writing.');
      return;
    }
    if (d.status !== 'active') {
      d.sink.abort('cancelled').catch(() => {});
      return;
    }
    if (d.meta.size === 0) {
      await this.#finish(d);
      return;
    }
    this.#request(d);
    this.changed();
  }

  /** Ask for the next window of bytes, keeping at most `receiveWindow` outstanding. */
  #request(d: Download) {
    if (d.status !== 'active' || !d.sink || this.#ctrl?.readyState !== 'open') return;
    const outstanding = d.requested - d.written;
    if (outstanding > config.receiveWindow / 2) return;
    const to = Math.min(d.meta.size, d.written + config.receiveWindow);
    if (to <= d.requested) return;
    this.#sendCtrl({ t: 'want', file: d.meta.id, from: d.requested, to });
    d.requested = to;
  }

  #resumeAfterManifest() {
    for (const d of this.#downloads.values()) {
      if (d.status !== 'active' && d.status !== 'queued') continue;
      const meta = this.#files.find((f) => f.id === d.meta.id);
      if (!meta) {
        this.#failDownload(d, 'The host stopped sharing this file.');
        continue;
      }
      if (d.status === 'active') {
        // New connection (or reconnect): forget what was in flight, ask again from what's on disk.
        d.pending.clear();
        d.requested = d.written;
        d.lastProgress = performance.now();
        this.#request(d);
      }
    }
    this.#startNext();
  }

  async #onFrame(data: unknown) {
    if (!(data instanceof ArrayBuffer)) return;
    let chunk: { fileId: number; offset: number; data: ArrayBuffer };
    try {
      chunk = await this.worker.decrypt(data);
    } catch {
      return; // tampered or garbage: GCM refused it, the stall check will re-request
    }
    const d = this.#downloads.get(chunk.fileId);
    if (!d || d.status !== 'active') return;
    if (chunk.offset < d.written || d.pending.has(chunk.offset)) return;
    if (chunk.offset + chunk.data.byteLength > d.meta.size) return;
    d.pending.set(chunk.offset, chunk.data);
    this.#speed.add(chunk.data.byteLength);
    this.#flush(d);
  }

  /** Write chunks to the sink strictly in order. */
  async #flush(d: Download) {
    if (d.writing) return;
    d.writing = true;
    try {
      while (d.status === 'active' && d.sink) {
        const data = d.pending.get(d.written);
        if (!data) break;
        d.pending.delete(d.written);
        await d.sink.write(new Uint8Array(data));
        d.written += data.byteLength;
        d.lastProgress = performance.now();
        this.#request(d);
        this.changed();
      }
      if (d.status === 'active' && d.written >= d.meta.size) await this.#finish(d);
    } catch (e) {
      const err = e as Error;
      this.#failDownload(d, err?.name === 'AbortError' ? 'The download was cancelled.' : err?.message || 'Writing the file failed.');
    } finally {
      d.writing = false;
    }
  }

  async #finish(d: Download) {
    await d.sink!.close();
    d.status = 'done';
    this.#sendCtrl({ t: 'complete', file: d.meta.id });
    this.#afterDownloadEnded();
  }

  #failDownload(d: Download, message: string) {
    if (d.status === 'done' || d.status === 'error' || d.status === 'cancelled') return;
    const wasActive = d.status === 'active';
    d.status = 'error';
    d.error = message;
    d.pending.clear();
    d.sink?.abort(message).catch(() => {});
    if (wasActive) this.#sendCtrl({ t: 'cancel', file: d.meta.id });
    this.#afterDownloadEnded();
  }

  #afterDownloadEnded() {
    this.#startNext();
    const all = [...this.#downloads.values()];
    if (!this.#batchDone && !all.some((d) => d.status === 'active' || d.status === 'queued') && all.some((d) => d.status === 'done')) {
      this.#batchDone = true;
      this.#sendCtrl({ t: 'finished' });
    }
    this.changed();
  }

  /** If nothing arrived for a while on a live connection, ask again from what's on disk. */
  #checkStalls() {
    if (this.#status !== 'connected') return;
    const now = performance.now();
    for (const d of this.#downloads.values()) {
      if (d.status !== 'active' || d.writing || !d.sink || d.meta.size === 0) continue;
      if (now - d.lastProgress < STALL_MS) continue;
      d.pending.clear();
      d.requested = d.written;
      d.lastProgress = now;
      this.#sendCtrl({ t: 'cancel', file: d.meta.id });
      this.#request(d);
    }
    if ([...this.#downloads.values()].some((d) => d.status === 'active')) this.changed();
  }

  // ---------------------------------------------------------------- leaving

  close() {
    clearInterval(this.#stallTimer);
    for (const d of this.#downloads.values()) {
      if (d.status === 'active' || d.status === 'queued') {
        d.status = 'cancelled';
        d.sink?.abort('left').catch(() => {});
      }
    }
    this.#teardown();
    this.worker.terminate();
    this.#status = 'closed';
  }
}
